// weather.js — Current weather via Open-Meteo (free, no API key, no account).
// Geocodes a place name → lat/lon, then fetches current conditions.
// Returns a short one-liner: "Rainy, 18°C in Afantou."

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FCST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 10000;

// WMO weather code → short human description
const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Light snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

function wmoText(code) {
  return WMO[code] || 'Unknown conditions';
}

async function fetchJson(url, params) {
  const qs = new URLSearchParams(params).toString();
  const full = `${url}?${qs}`;
  const r = await fetch(full, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Pick the best geocode hit by scoring it against the FULL original input (not just the
// short candidate we searched), so "Athens, Greece" can't silently resolve to Athens, GA.
// An exact-name match on the first component wins outright — this is what makes non-Latin
// input (東京 / Αθήνα) work, where token-scoring would score 0 and mis-pick.
function pickBest(results, loc) {
  const norm = s => String(s || '').normalize('NFC').toLowerCase().trim();
  const first = norm(loc.split(',')[0]);
  const exact = results.find(g => norm(g.name) === first);
  if (exact) return exact;
  const tokens = loc.toLowerCase().split(/[\s,]+/).filter(t => t.length > 1);
  let best = results[0], bestScore = -1;
  for (const g of results) {
    const hay = [g.name, g.admin1, g.admin2, g.country, g.country_code].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score++;
    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best;
}

/**
 * Get current weather for a place name.
 * @param {string} location - e.g. "Afantou, Rhodes, Greece"
 * @returns {Promise<string>} e.g. "Rainy, 18°C in Afantou, Rhodes, Greece."
 */
export async function weather(location) {
  // String() so a non-string arg ({"location":123}) can't throw on .trim and kill the turn.
  const loc = String(location ?? '').trim();
  if (!loc) return 'Error: "location" required.';

  // 1) Geocode — try the full string first, then fall back to the first component
  //    (small villages are often unknown in their full "Town, Region, Country" form but
  //     known by name alone). Ask for a few results and score against the FULL input so
  //     ambiguous names resolve to the right country. A network/HTTP error stops here —
  //     the shorter candidate would fail identically, so we report the real reason.
  const candidates = [loc, loc.split(',')[0].trim()].filter((v, i, a) => v && a.indexOf(v) === i);
  let g = null, lastErr = null;
  for (const c of candidates) {
    try {
      const r = await fetchJson(GEO_URL, { name: c, count: 5, language: 'en' });
      if (r.results && r.results.length > 0) { g = pickBest(r.results, loc); break; }
      // zero results → try the shorter candidate
    } catch (err) {
      lastErr = err;
      break;
    }
  }
  if (!g) {
    if (lastErr) return `Weather geocoding failed: ${lastErr.message}`;
    return `Could not find location: ${loc}. Try a more specific place name (city, region, country).`;
  }

  const lat = Number(g.latitude), lon = Number(g.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return `Weather geocoding failed: no coordinates for ${g.name || loc}.`;
  }
  const name = [...new Set([g.name, g.admin1, g.country].filter(Boolean))].join(', ');

  // 2) Current weather
  try {
    const fc = await fetchJson(FCST_URL, {
      latitude: lat,
      longitude: lon,
      current: 'weather_code,temperature_2m',
    });
    const cur = fc.current;
    const t = Number(cur?.temperature_2m);
    if (!cur || !Number.isFinite(t)) return `Weather data unavailable for ${name}.`;
    const desc = wmoText(cur.weather_code);
    const unit = fc.current_units?.temperature_2m || '°C';
    return `${desc}, ${Math.round(t)}${unit} in ${name}.`;
  } catch (err) {
    return `Weather fetch failed: ${err.message}`;
  }
}
