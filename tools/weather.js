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

/**
 * Get current weather for a place name.
 * @param {string} location - e.g. "Afantou, Rhodes, Greece"
 * @returns {Promise<string>} e.g. "Rainy, 18°C in Afantou, Rhodes, Greece."
 */
export async function weather(location) {
  const loc = (location || '').trim();
  if (!loc) return 'Error: "location" required.';

  // 1) Geocode — try the full string first, then fall back to the first word
  //    (small villages like "Afantou" are in a multi-word string like
  //     "Afantou, Rhodes, Greece" but the geocoder only knows "Afantou").
  const candidates = [loc, loc.split(',')[0].trim()].filter((v, i, a) => v && a.indexOf(v) === i);
  let geo = null;
  for (const c of candidates) {
    try {
      const r = await fetchJson(GEO_URL, { name: c, count: 1, language: 'en' });
      if (r.results && r.results.length > 0) { geo = r; break; }
    } catch { /* try next candidate */ }
  }
  if (!geo || !geo.results || geo.results.length === 0) {
    return `Could not find location: ${loc}. Try a more specific place name (city, region, country).`;
  }
  const g = geo.results[0];
  const lat = g.latitude;
  const lon = g.longitude;
  const name = [g.name, g.admin1, g.country].filter(Boolean).join(', ');

  // 2) Current weather
  try {
    const fc = await fetchJson(FCST_URL, {
      latitude: lat,
      longitude: lon,
      current: 'weather_code,temperature_2m',
      timezone: 'auto',
    });
    const cur = fc.current;
    if (!cur) return `Weather data unavailable for ${name}.`;
    const desc = wmoText(cur.weather_code);
    const temp = Math.round(cur.temperature_2m);
    return `${desc}, ${temp}°C in ${name}.`;
  } catch (err) {
    return `Weather fetch failed: ${err.message}`;
  }
}
