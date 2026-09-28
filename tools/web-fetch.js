// web-fetch.js — Fetch and parse a URL. FULLY LOCAL: direct fetch + HTML→text.

const net = globalThis.fetch;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LIMIT = 20000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export async function readTextLimited(response, limit = MAX_RESPONSE_BYTES) {
    const reader = response.body?.getReader();
    if (!reader) return { text: '', truncated: false };

    const decoder = new TextDecoder();
    let text = '';
    let bytesRead = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) return { text: text + decoder.decode(), truncated: false };

        const remaining = limit - bytesRead;
        if (value.byteLength > remaining) {
            text += decoder.decode(value.subarray(0, remaining), { stream: true });
            text += decoder.decode();
            await reader.cancel();
            return { text, truncated: true };
        }

        bytesRead += value.byteLength;
        text += decoder.decode(value, { stream: true });
    }
}

export function htmlToText(html) {
    if (!html) return '';
    let text = html;

    // 1. Remove non-content blocks accurately (script, style, noscript, etc.)
    text = text.replace(/<(script|style|noscript|iframe|svg|math)[^>]*>[\s\S]*?<\/\1>/gi, '');

    // 2. Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // 3. Convert Block elements → double newline (paragraph break)
    const BLOCK_TAGS = 'p|div|hr|h[1-6]|li|tr|blockquote|pre|table|section|article|header|footer|nav|main|aside|figure|figcaption|details|summary|dl|dt|dd|address|form|fieldset|legend|button|input|textarea|select|option|video|audio|source|canvas|embed|object|param|track|map|area|picture|slot|template';
    text = text.replace(new RegExp(`</?(${BLOCK_TAGS})[^>]*>`, 'gi'), '\n\n');

    // Convert explicit line breaks (<br>, <br/>) → single newline
    text = text.replace(/<br\s*\/?>/gi, '\n');

    // 4. Convert Inline elements → single space (preserves sentence continuity)
    const INLINE_TAGS = 'span|label|a|strong|em|b|i|u|s|mark|code|kbd|samp|var|sub|sup|ins|del|abbr|dfn|q|small|big|cite|font|tt|bdo|bdi|wbr|img';
    text = text.replace(new RegExp(`</?(${INLINE_TAGS})[^>]*>`, 'gi'), ' ');

    // 5. Remove any remaining unhandled HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // 6. Decode common HTML entities
    text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');

    // 7. Normalize line breaks and spaces cleanly
    text = text
    .replace(/[ \t]+/g, ' ')               // Collapse horizontal spaces
    .replace(/ ?\n ?/g, '\n')              // Trim spaces surrounding newlines
    .replace(/\n{3,}/g, '\n\n')            // Max 2 consecutive newlines
    .trim();

    return text;
}

function truncate(s) {
    return s.length > LIMIT ? s.substring(0, LIMIT) + '\n... [truncated]' : s;
}

// Heuristic: Check if page is an unrendered JS shell or anti-bot challenge
function looksLikeShell(html, plain) {
    // If we extracted a good amount of text, it's real content (even if Next.js / Nuxt SSR)
    if (plain.length >= 300) {
        // Only check for obvious anti-bot walls if text length is moderate
        if (/Enable JavaScript and cookies|cf-chl|__cf_chl_|Just a moment|challenge-platform|captcha|Access Denied|Attention Required/i.test(plain)) {
            return true;
        }
        return false;
    }

    // If extracted text is under 300 chars AND contains JS framework entry points, it's a client-side shell
    if (/__next|__nuxt|__vue|id="app"|data-reactroot|ng-app/i.test(html)) {
        return true;
    }

    return false;
}

export function fetch(url) {
    return net(url, {
        signal: AbortSignal.timeout(30000),
               redirect: 'follow',
               headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    }).then(async (resp) => {
        const { text: html, truncated } = await readTextLimited(resp);
        if (!resp.ok) {
            return `HTTP ${resp.status}: page not available${resp.status === 403 ? ' (likely blocked by anti-bot — try a different source)' : ''}.`;
        }
        const plain = htmlToText(html);
        if (looksLikeShell(html, plain)) {
            const hint = '[No readable content — page appears JS-rendered or bot-walled. Try a different source.]';
            return hint + (plain ? '\n\n(raw text):\n' + truncate(plain) : '');
        }
        const content = truncate(plain) || 'Page returned no readable text.';
        return truncated ? `${content}\n... [source response truncated at 1 MB]` : content;
    }).catch((err) => `Fetch error: ${err.message}`);
}
