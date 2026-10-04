// web-fetch.js — Fetch and parse a URL. FULLY LOCAL: direct fetch + HTML→text.

import { lookup } from 'node:dns/promises';

const net = globalThis.fetch;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LIMIT = 20000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

// ── SSRF guard: block private / loopback / link-local / reserved ranges ──
// web_fetch is a tool the model can call on its own. Without this, a malicious
// page or search result could steer it to read internal services (e.g.
// http://127.0.0.1:8787, cloud metadata at 169.254.169.254) and exfiltrate data.
function isPrivateIPv4(ip) {
    const o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some((x) => Number.isNaN(x))) return true; // unparseable → block
    const [a, b] = o;
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 127) return true;                     // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
}
function isPrivateIPv6(ip) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;     // unspecified / loopback
    if (/^fe80:/i.test(v)) return true;             // fe80::/10 link-local
    if (/^(fc|fd)/.test(v)) return true;            // fc00::/7 unique local
    if (/^::ffff:/.test(v)) {                       // IPv4-mapped → check the v4 part
        const m = v.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
        return m ? isPrivateIPv4(m[1]) : true;
    }
    return false;
}
async function assertPublicHost(hostname) {
    if (!hostname) throw new Error('no host');
    // Literal IP address
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) { if (isPrivateIPv4(hostname)) throw new Error(`blocked private/loopback address: ${hostname}`); return; }
    if (hostname.includes(':')) { if (isPrivateIPv6(hostname)) throw new Error(`blocked private/loopback address: ${hostname}`); return; }
    // Hostname → resolve and check every returned address
    const addrs = await lookup(hostname, { all: true });
    for (const a of addrs) {
        if ((a.family === 4 && isPrivateIPv4(a.address)) || (a.family === 6 && isPrivateIPv6(a.address))) {
            throw new Error(`blocked private/loopback address: ${hostname} → ${a.address}`);
        }
    }
}

// Detect the charset from the HTTP Content-Type header or a <meta> tag.
// Without this, ISO-8859-7 (Greek) and other legacy encodings decode as UTF-8
// and come out as mojibake ("??????"). Returns a TextDecoder label.
function detectCharset(response, headBytes) {
    const ct = response.headers?.get('content-type') || '';
    const m = ct.match(/charset=([\w-]+)/i);
    if (m) return m[1];
    // Fall back to a <meta charset> in the first chunk (decoded as latin1 so the
    // ASCII meta tag is readable regardless of the real encoding).
    const head = new TextDecoder('latin1').decode(headBytes.slice(0, 2048));
    const mm = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
    if (mm) return mm[1];
    return 'utf-8'; // default
}

// Map common charset names to labels TextDecoder understands.
function normalizeLabel(label) {
    const l = String(label || '').toLowerCase().trim();
    const aliases = {
        'iso-8859-7': 'iso-8859-7', 'el': 'iso-8859-7', 'greek': 'iso-8859-7',
        'windows-1253': 'windows-1253', 'cp1253': 'windows-1253',
        'iso-8859-1': 'latin1', 'latin1': 'latin1', 'iso-8859-15': 'iso-8859-15',
        'utf-8': 'utf-8', 'utf8': 'utf-8',
    };
    return aliases[l] || l;
}

export async function readTextLimited(response, limit = MAX_RESPONSE_BYTES) {
    const reader = response.body?.getReader();
    if (!reader) return { text: '', truncated: false };

    // Read the first chunk to detect charset before decoding the rest.
    let firstRead;
    try { firstRead = await reader.read(); }
    catch (e) { return { text: '', truncated: false }; }
    const firstChunk = firstRead.value;
    if (!firstChunk || firstChunk.byteLength === 0) {
        // Empty body — drain any remaining reads and return nothing.
        while (true) { const r = await reader.read(); if (r.done) break; }
        return { text: '', truncated: false };
    }

    const label = normalizeLabel(detectCharset(response, firstChunk));
    let decoder;
    try { decoder = new TextDecoder(label); }
    catch { decoder = new TextDecoder('utf-8'); }

    let text = '';
    let bytesRead = 0;
    // decode the first chunk we already have
    const remaining0 = limit - 0;
    if (firstChunk.byteLength > remaining0) {
        text += decoder.decode(firstChunk.subarray(0, remaining0), { stream: true });
        await reader.cancel();
        return { text, truncated: true };
    }
    bytesRead = firstChunk.byteLength;
    text += decoder.decode(firstChunk, { stream: true });

    while (true) {
        const { done, value } = await reader.read();
        if (done) return { text: text + decoder.decode(), truncated: false };

        const remaining = limit - bytesRead;
        if (value.byteLength > remaining) {
            text += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
            await reader.cancel();
            return { text, truncated: true };
        }

        bytesRead += value.byteLength;
        text += decoder.decode(value, { stream: true });
    }
}

// Remove <script>/<style>/<noscript>/<iframe>/<svg>/<math> blocks in LINEAR time.
// The old regex `/<(tag)[^>]*>[\s\S]*?<\/tag>/` is a catastrophic-backtracking
// shape: on an unclosed tag, [^>]* eats to EOF and [\s\S]*? scans back through
// every position → O(n²). A hostile page (fetched automatically by web_search)
// could freeze the server for tens of seconds. This scanner is O(n): find each
// opening tag, then indexOf its closing tag; an unclosed block drops to EOF.
function stripNonContentBlocks(html) {
    const TAGS = ['script', 'style', 'noscript', 'iframe', 'svg', 'math'];
    let out = '';
    let i = 0;          // current scan position
    let lastCopy = 0;   // start of the not-yet-copied text we keep
    const n = html.length;
    while (i < n) {
        const lt = html.indexOf('<', i);
        if (lt === -1) { out += html.slice(lastCopy); break; }
        // Does a target tag start right after this '<'?
        let matchedTag = null;
        for (const t of TAGS) {
            if (html.startsWith(t, lt + 1)) {
                const after = html[lt + 1 + t.length];
                // word boundary: end-of-string or a non-alphanumeric char
                if (after === undefined || !/[a-zA-Z0-9]/.test(after)) { matchedTag = t; break; }
            }
        }
        if (!matchedTag) { i = lt + 1; continue; } // not one of our tags — keep scanning
        const isClosing = html[lt + 1 + matchedTag.length] === '/';
        if (isClosing) {
            // Stray closing tag with no matching open — copy it through as text.
            i = lt + 1;
            continue;
        }
        // Opening tag: find the end of the tag ('>'), then its closing tag.
        const gt = html.indexOf('>', lt);
        if (gt === -1) { break; }                 // malformed, no '>' — drop to EOF
        const closeIdx = html.indexOf(`</${matchedTag}`, gt + 1);
        if (closeIdx === -1) { break; }           // unclosed block — drop to EOF (was O(n²))
        // Keep text before this opening tag, then skip the whole block.
        out += html.slice(lastCopy, lt);
        const closeGt = html.indexOf('>', closeIdx);
        i = lastCopy = (closeGt === -1) ? n : closeGt + 1;
    }
    return out;
}

// Common named HTML entities (the ones that actually appear in real pages).
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', plusmn: '\u00b1',
    middot: '\u00b7', bull: '\u2022', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb',
    iexcl: '\u00a1', iquest: '\u00bf', sect: '\u00a7', para: '\u00b6', dagger: '\u2020',
    spades: '\u2660', clubs: '\u2663', hearts: '\u2665', diams: '\u2666', euro: '\u20ac',
};

// Decode HTML entities in a SINGLE pass. Handles named (&mdash;), decimal numeric
// (&#8212;) and hex numeric (&#x2014;) forms. Because it's one regex pass, an
// already-encoded sequence like &amp;lt; decodes to the literal text "&lt;" (not
// further to <) — no double-decoding.
function decodeEntities(text) {
    if (!text || text.indexOf('&') === -1) return text;
    return text.replace(/&#(\d+);|&#x([0-9a-fA-F]+);|&([a-zA-Z][a-zA-Z0-9]*);/g, (match, dec, hex, name) => {
        if (dec !== undefined) {
            const cp = parseInt(dec, 10);
            return Number.isFinite(cp) && cp > 0 ? safeCharFromCodePoint(cp) : match;
        }
        if (hex !== undefined) {
            const cp = parseInt(hex, 16);
            return Number.isFinite(cp) && cp > 0 ? safeCharFromCodePoint(cp) : match;
        }
        if (name in NAMED_ENTITIES) return NAMED_ENTITIES[name];
        return match; // unknown entity — leave as-is
    });
}
function safeCharFromCodePoint(cp) {
    try { return String.fromCodePoint(cp); } catch { return ''; }
}

export function htmlToText(html) {
    if (!html) return '';
    let text = stripNonContentBlocks(html);

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

    // 6. Decode HTML entities ONCE (single pass). The old sequential replaces
    // double-decoded (&amp;lt; → &lt; → <) and left named/numeric entities like
    // &#8217;, &mdash;, &hellip; raw. A single regex pass decodes each entity
    // exactly once, so already-encoded text stays correctly encoded.
    text = decodeEntities(text);

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

// Heuristic: Check if page is an unrendered JS shell or anti-bot challenge.
// A real wall has almost NO readable content plus a strong challenge signal.
// A normal page that merely MENTIONS "reCAPTCHA" in its footer (or has lots of
// real text) must NOT be flagged — the old check did, because it matched the
// word "captcha" anywhere in the body.
function looksLikeShell(html, plain) {
    // Strong wall signals: these appear on actual challenge pages, not footers.
    const STRONG_WALL = /Enable JavaScript and cookies|cf-chl|__cf_chl_|Just a moment\.|challenge-platform|Access Denied|Attention Required|Please verify you are a human/i;

    if (plain.length >= 300) {
        // Plenty of real text → it's content, not a wall. Even if the word
        // "captcha" appears in a footer, we have enough to work with.
        return false;
    }

    // Little/no readable text: is it a challenge page or just a JS shell?
    if (STRONG_WALL.test(plain)) {
        return true; // genuine anti-bot wall
    }
    // Client-side framework shell (no SSR content)
    if (/__next|__nuxt|__vue|id="app"|data-reactroot|ng-app/i.test(html)) {
        return true;
    }

    return false;
}

export async function fetch(url) {
    // SSRF guard — resolve the host and reject private/loopback/link-local targets
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new Error(`invalid URL: ${url}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`only http(s) URLs are allowed, got: ${parsed.protocol}`);
    }
    await assertPublicHost(parsed.hostname);
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
    }).catch((err) => {
        // Include the URL and a hint so "fetch failed" is actually actionable.
        const name = err?.name || '';
        let hint = '';
        if (name === 'TimeoutError' || /timeout|timed out/i.test(err?.message || '')) hint = ' (the server took too long to respond)';
        else if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err?.message || '')) hint = ' (network error — check the URL, your connection, or that the host resolves)';
        return `Fetch error for ${url}: ${err?.message || String(err)}${hint}`;
    });
}
