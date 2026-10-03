// web-search.js — Search via DuckDuckGo HTML (POST method) + Local Page Extraction

import { htmlToText, readTextLimited } from './web-fetch.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv/128.0) Gecko/20100101 Firefox/128.0';

function decodeEntities(str) {
    return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractRealUrl(ddgUrl) {
    try {
        const raw = decodeEntities(ddgUrl);
        const match = raw.match(/[?&]uddg=([^&]+)/);
        if (match) {
            return decodeURIComponent(match[1]);
        }
        return raw;
    } catch {
        return ddgUrl;
    }
}

function parseDuckDuckGoResults(html) {
    const results = [];
    const seen = new Set();

    // Strip tags helper to extract clean title text even if inside <span> or <b>
    const cleanTitle = (rawHtml) => decodeEntities(rawHtml.replace(/<[^>]+>/g, '')).trim();

    // Strategy 1: Match result__a class (handles nested HTML inside <a>)
    const primaryRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = primaryRegex.exec(html)) !== null) {
        const url = extractRealUrl(m[1]);
        const title = cleanTitle(m[2]);
        if (url && title && url.startsWith('http') && !seen.has(url)) {
            seen.add(url);
            results.push({ title, url });
            if (results.length >= 10) break;
        }
    }

    // Strategy 2: Fallback for redirect links (/l/?uddg= or /uddg=)
    if (!results.length) {
        const fallbackRegex = /<a[^>]*href="([^"]*(?:uddg|\/l\/)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let fm;
        while ((fm = fallbackRegex.exec(html)) !== null) {
            const url = extractRealUrl(fm[1]);
            const title = cleanTitle(fm[2]);
            if (url && title && title.length >= 3 && url.startsWith('http') && !seen.has(url)) {
                seen.add(url);
                results.push({ title, url });
                if (results.length >= 10) break;
            }
        }
    }

    return results;
}

async function fetchPageContent(url) {
    try {
        const resp = await fetch(url, {
            signal: AbortSignal.timeout(15000),
                                 redirect: 'follow',
                                 headers: {
                                     'User-Agent': USER_AGENT,
                                     'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                                 },
        });
        if (!resp.ok) return null;
        const { text: html } = await readTextLimited(resp);
        const text = htmlToText(html);
        if (!text || !text.trim()) return null;
        return text.trim().substring(0, 3000);
    } catch {
        return null;
    }
}

export async function search(query) {
    const ddgUrl = 'https://html.duckduckgo.com/html/';

    try {
        // Send POST request instead of GET to reduce CAPTCHA/bot challenges
        const resp = await fetch(ddgUrl, {
            method: 'POST',
            signal: AbortSignal.timeout(15000),
                                 headers: {
                                     'User-Agent': USER_AGENT,
                                     'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                     'Accept-Language': 'en-US,en;q=0.9',
                                     'Content-Type': 'application/x-www-form-urlencoded',
                                     'Cache-Control': 'no-cache',
                                     'Origin': 'https://html.duckduckgo.com',
                                     'Referer': 'https://html.duckduckgo.com/'
                                 },
                                 body: new URLSearchParams({ q: query, b: '' }).toString()
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const { text: html } = await readTextLimited(resp);

        if (!html.trim() || html.includes('anomaly-modal') || html.includes('Check if you are a bot')) {
            throw new Error('DuckDuckGo bot detection triggered.');
        }

        const results = parseDuckDuckGoResults(html);
        if (!results.length) {
            // The regex-based parser may be outdated if DuckDuckGo changed their HTML.
            // Give the user a clear hint rather than a silent failure.
            throw new Error("No DDG results parsed. (The search engine's page structure may have changed — try again later or use web_fetch directly on a known URL.)");
        }

        // Fetch content from top 3 URLs in parallel
        const topUrls = results.slice(0, 3);
        const fetchedResults = await Promise.all(
            topUrls.map(async (u, i) => {
                const content = await fetchPageContent(u.url);
                return { index: i + 1, title: u.title, url: u.url, content };
            })
        );

        // Build output string
        let output = `Search results for "${query}":\n\n`;
        output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n\n');

        output += '\n\n---\nTop results (content fetched locally):';
        for (const r of fetchedResults) {
            if (r.content) {
                output += `\n\n[${r.index}] ${r.title}\n${r.url}\n---\n${r.content}\n---`;
            } else {
                output += `\n\n[${r.index}] ${r.title}\n${r.url}\n[Content unavailable]`;
            }
        }

        return output;
    } catch (err) {
        const msg = err?.message || String(err);
        if (/HTTP 429|rate/i.test(msg)) return `Search failed for "${query}": rate limited by DuckDuckGo.`;
        if (/bot|anomaly/i.test(msg)) return `Search failed for "${query}": DuckDuckGo bot detection triggered.`;
        if (/No DDG results/i.test(msg)) return `Search failed for "${query}": no results found or HTML structure changed.`;
        if (/timeout|aborted/i.test(msg)) return `Search failed for "${query}": request timed out.`;
        return `Search failed for "${query}": ${msg}`;
    }
}
