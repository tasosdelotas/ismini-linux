// web-search.js — Search with automatic engine fallback + local page extraction.
// Engines tried in order: DuckDuckGo Lite → DuckDuckGo HTML → Mojeek.
// Fully local parsing, no API keys.
import { htmlToText, readTextLimited } from './web-fetch.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

function safeChar(cp) {
  try { return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : ''; } catch { return ''; }
}

function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // must be last to avoid double-decoding
}

function extractRealUrl(ddgUrl) {
  try {
    const raw = decodeEntities(ddgUrl);
    const match = raw.match(/[?&]uddg=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
    return raw;
  } catch { return ddgUrl; }
}

const cleanTitle = (rawHtml) => decodeEntities(rawHtml.replace(/<[^>]+>/g, '')).trim();

// ── Engine 1: DuckDuckGo Lite (simple GET, most lenient) ───────────────
async function searchDdgLite(query) {
  const url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
  const resp = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
  });
  if (!resp.ok) throw new Error(`DDG lite HTTP ${resp.status}`);
  const { text: html } = await readTextLimited(resp);
  if (/anomaly|are you a bot|captcha/i.test(html)) throw new Error('DDG lite bot detection');
  const results = [];
  const seen = new Set();
  const re = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = extractRealUrl(m[1]);
    const title = cleanTitle(m[2]);
    if (u && title && u.startsWith('http') && !seen.has(u)) {
      seen.add(u);
      results.push({ title, url: u });
      if (results.length >= 10) break;
    }
  }
  return results;
}

// ── Engine 2: DuckDuckGo HTML (POST) ───────────────────────────────────
async function searchDdgHtml(query) {
  const resp = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://html.duckduckgo.com',
      'Referer': 'https://html.duckduckgo.com/',
    },
    body: new URLSearchParams({ q: query, b: '' }).toString(),
  });
  if (!resp.ok) throw new Error(`DDG html HTTP ${resp.status}`);
  const { text: html } = await readTextLimited(resp);
  if (/anomaly-modal|Check if you are a bot/i.test(html)) throw new Error('DDG html bot detection');

  const results = [];
  const seen = new Set();
  const primary = /<a(?=[^>]*class="[^"]*result__a")[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = primary.exec(html)) !== null) {
    const u = extractRealUrl(m[1]);
    const title = cleanTitle(m[2]);
    if (u && title && u.startsWith('http') && !seen.has(u)) {
      seen.add(u);
      results.push({ title, url: u });
      if (results.length >= 10) break;
    }
  }
  if (!results.length) {
    const fallback = /<a[^>]*href="([^"]*(?:uddg|\/l\/)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = fallback.exec(html)) !== null) {
      const u = extractRealUrl(m[1]);
      const title = cleanTitle(m[2]);
      if (u && title && title.length >= 3 && u.startsWith('http') && !seen.has(u)) {
        seen.add(u);
        results.push({ title, url: u });
        if (results.length >= 10) break;
      }
    }
  }
  return results;
}

// ── Engine 3: Mojeek (independent index, no bot wall) ──────────────────
async function searchMojeek(query) {
  const url = 'https://www.mojeek.com/search?q=' + encodeURIComponent(query);
  const resp = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
  });
  if (!resp.ok) throw new Error(`Mojeek HTTP ${resp.status}`);
  const { text: html } = await readTextLimited(resp);
  const results = [];
  const seen = new Set();
  const re = /<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    const title = cleanTitle(m[2]);
    if (u && title && u.startsWith('http') && !seen.has(u)) {
      seen.add(u);
      results.push({ title, url: u });
      if (results.length >= 10) break;
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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!resp.ok) return null;
    const { text: html } = await readTextLimited(resp);
    const text = htmlToText(html);
    if (!text || !text.trim()) return null;
    return text.trim().substring(0, 3000);
  } catch { return null; }
}

export async function search(query) {
  const engines = [
    { name: 'DuckDuckGo Lite', fn: searchDdgLite },
    { name: 'DuckDuckGo', fn: searchDdgHtml },
    { name: 'Mojeek', fn: searchMojeek },
  ];

  let results = [];
  let lastErr = null;
  for (const eng of engines) {
    try {
      results = await eng.fn(query);
      if (results.length) break;
    } catch (e) { lastErr = e; }
  }

  if (!results.length) {
    const msg = lastErr?.message || 'no results';
    if (/bot|anomaly|captcha/i.test(msg)) {
      return `Search failed for "${query}": all engines hit bot detection. Try web_fetch on a specific URL instead.`;
    }
    return `Search failed for "${query}": no results found (${msg}).`;
  }

  const topUrls = results.slice(0, 3);
  const fetchedResults = await Promise.all(
    topUrls.map(async (u, i) => {
      const content = await fetchPageContent(u.url);
      return { index: i + 1, title: u.title, url: u.url, content };
    })
  );

  let output = `Search results for "${query}":\n\n`;
  output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n\n');
  output += '\n\n---\nTop results (content fetched locally):';
  for (const r of fetchedResults) {
    if (r.content) output += `\n\n[${r.index}] ${r.title}\n${r.url}\n---\n${r.content}\n---`;
    else output += `\n\n[${r.index}] ${r.title}\n${r.url}\n[Content unavailable]`;
  }
  return output;
}