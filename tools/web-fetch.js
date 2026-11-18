// web-fetch.js — Fetch and parse a URL. FULLY LOCAL: direct fetch + HTML→text.
import { lookup } from 'node:dns/promises';

const rawFetch = globalThis.fetch;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LIMIT = 20000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

// ── SSRF guard: block private / loopback / link-local / reserved ranges ──
function isPrivateIPv4(ip) {
  let normalized;
  try {
    const url = new URL('http://' + ip + '/test');
    normalized = url.hostname;
  } catch {
    return true;
  }
  const parts = normalized.split('.');
  if (parts.length !== 4) return true;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return true;
  }
  const [a, b] = parts.map(p => parseInt(p, 10));
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(ip) {
  let v = ip.replace(/^\[|\]$/g, '').toLowerCase();
  try {
    const url = new URL('http://[' + v + ']/test');
    let normalized = url.hostname.toLowerCase();
    normalized = normalized.replace(/\[|\]/g, '');
    if (normalized === '::' || normalized === '::1') return true;
    if (/^fe80:/i.test(normalized)) return true;
    if (/^(fc|fd)/.test(normalized)) return true;
    if (/^::ffff:/.test(normalized)) {
      const m = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
      return m ? isPrivateIPv4(m[1]) : true;
    }
    return false;
  } catch {
    return true;
  }
}

// Exported so web-search.js can reuse the SAME SSRF guard (search-result URLs are
// attacker-influenceable, so they must be validated too).
export async function assertPublicHost(hostname) {
  if (!hostname) throw new Error('no host');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) throw new Error(`blocked private/loopback address: ${hostname}`);
    return;
  }
  if (hostname.includes(':')) {
    const ipv6Addr = hostname.replace(/^\[|\]$/g, '');
    if (isPrivateIPv6(ipv6Addr)) throw new Error(`blocked private/loopback address: ${hostname}`);
    return;
  }
  const addrs = await lookup(hostname, { all: true });
  for (const a of addrs) {
    if ((a.family === 4 && isPrivateIPv4(a.address)) || (a.family === 6 && isPrivateIPv6(a.address))) {
      throw new Error(`blocked private/loopback address: ${hostname} → ${a.address}`);
    }
  }
}

function detectCharset(response, headBytes) {
  const ct = response.headers?.get('content-type') || '';
  const m = ct.match(/charset=([\w-]+)/i);
  if (m) return m[1];
  const head = new TextDecoder('latin1').decode(headBytes.slice(0, 2048));
  const mm = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (mm) return mm[1];
  return 'utf-8';
}

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
  let firstRead;
  try { firstRead = await reader.read(); } catch { return { text: '', truncated: false }; }
  const firstChunk = firstRead.value;
  if (!firstChunk || firstChunk.byteLength === 0) {
    while (true) { const r = await reader.read(); if (r.done) break; }
    return { text: '', truncated: false };
  }
  const label = normalizeLabel(detectCharset(response, firstChunk));
  let decoder;
  try { decoder = new TextDecoder(label); } catch { decoder = new TextDecoder('utf-8'); }
  let text = '';
  let bytesRead = 0;
  if (firstChunk.byteLength > limit) {
    text += decoder.decode(firstChunk.subarray(0, limit), { stream: true });
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

function stripNonContentBlocks(html) {
  const TAGS = ['script', 'style', 'noscript', 'iframe', 'svg', 'math'];
  let out = '';
  let i = 0;
  let lastCopy = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(lastCopy); break; }
    // Match the tag name case-insensitively (so <SCRIPT>/<IFRAME> are stripped too),
    // comparing a small slice rather than lowercasing the whole string — toLowerCase()
    // can change length for some Unicode and would misalign every index.
    let matchedTag = null;
    const name = html.slice(lt + 1, lt + 9).toLowerCase(); // longest TAG is 'noscript' (8)
    for (const t of TAGS) {
      if (name.startsWith(t)) {
        const after = name[t.length];
        if (after === undefined || !/[a-z0-9]/.test(after)) { matchedTag = t; break; }
      }
    }
    if (!matchedTag) { i = lt + 1; continue; }
    const gt = html.indexOf('>', lt);
    if (gt === -1) { break; }
    const closeMatch = new RegExp(`</${matchedTag}\\b`, 'i').exec(html.slice(gt + 1));
    if (!closeMatch) { break; }
    out += html.slice(lastCopy, lt);
    const closeGt = html.indexOf('>', gt + 1 + closeMatch.index);
    i = lastCopy = (closeGt === -1) ? n : closeGt + 1;
  }
  return out;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', plusmn: '\u00b1',
  middot: '\u00b7', bull: '\u2022', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb',
  iexcl: '\u00a1', iquest: '\u00bf', sect: '\u00a7', para: '\u00b6', dagger: '\u2020',
  spades: '\u2660', clubs: '\u2663', hearts: '\u2665', diams: '\u2666', euro: '\u20ac',
};

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
    return match;
  });
}

function safeCharFromCodePoint(cp) {
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

export function htmlToText(html) {
  if (!html) return '';
  let text = stripNonContentBlocks(html);
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  const BLOCK_TAGS = 'p|div|hr|h[1-6]|li|tr|blockquote|pre|table|section|article|header|footer|nav|main|aside|figure|figcaption|details|summary|dl|dt|dd|address|form|fieldset|legend|button|input|textarea|select|option|video|audio|source|canvas|embed|object|param|track|map|area|picture|slot|template';
  text = text.replace(new RegExp(`</?(${BLOCK_TAGS})[^>]*>`, 'gi'), '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  const INLINE_TAGS = 'span|label|a|strong|em|b|i|u|s|mark|code|kbd|samp|var|sub|sup|ins|del|abbr|dfn|q|small|big|cite|font|tt|bdo|bdi|wbr|img';
  text = text.replace(new RegExp(`</?(${INLINE_TAGS})[^>]*>`, 'gi'), ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function truncate(s) {
  return s.length > LIMIT ? s.substring(0, LIMIT) + '\n... [truncated]' : s;
}

function looksLikeShell(html, plain) {
  const STRONG_WALL = /Enable JavaScript and cookies|cf-chl|_cf_chl|Just a moment.|challenge-platform|Access Denied|Attention Required|Please verify you are a human/i;
  if (plain.length >= 300) return false;
  if (STRONG_WALL.test(plain)) return true;
  if (/__next|__nuxt|__vue|id="app"|data-reactroot|ng-app/i.test(html)) return true;
  return false;
}

// Content types this tool can meaningfully turn into text. Anything else (PDF, ZIP,
// images, …) is refused instead of being decoded as UTF-8 and fed to the model as
// ~20k chars of mojibake. octet-stream is allowed through — some servers mislabel HTML.
const TEXTY_CT = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|javascript|rss\+xml|atom\+xml))|octet-stream/;

export async function fetch(url) {
  try {
    // Follow redirects MANUALLY and re-validate the SSRF guard on EVERY hop. With
    // redirect:'follow', a public page could 302 → http://127.0.0.1:8080 (our own
    // llama-server) or the cloud metadata IP and the guard would never see it.
    const MAX_REDIRECTS = 5;
    let current = url, resp = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(current);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `Fetch error for ${url}: only http(s) URLs are allowed, got ${parsed.protocol}`;
      }
      await assertPublicHost(parsed.hostname); // ← every hop
      resp = await rawFetch(current, {
        signal: AbortSignal.timeout(30000),
        redirect: 'manual',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      });
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        current = new URL(loc, current).href;
        try { await resp.body?.cancel(); } catch {}
        continue;
      }
      break;
    }
    if (!resp || (resp.status >= 300 && resp.status < 400)) {
      return `Fetch error for ${url}: too many redirects`;
    }

    // Refuse binary content before decoding it as text.
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct && !TEXTY_CT.test(ct)) {
      try { await resp.body?.cancel(); } catch {}
      return `Fetch error: unsupported content type "${ct}" — this tool reads text pages. For PDFs use exec with pdftotext; for archives use exec with unzip -l.`;
    }

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
  } catch (err) {
    // URL-parse, non-http protocol, SSRF block, and DNS failure all happen OUTSIDE the
    // network call — without this they'd propagate out of run() and kill the turn.
    const name = err?.name || '';
    let hint = '';
    if (name === 'TimeoutError' || /timeout|timed out/i.test(err?.message || '')) hint = ' (the server took too long to respond)';
    else if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err?.message || '')) hint = ' (network error — check the URL, your connection, or that the host resolves)';
    return `Fetch error for ${url}: ${err?.message || String(err)}${hint}`;
  }
}