/**
 * Data providers behind the paywall. Uses the free Open-Meteo APIs (no key) for real data and
 * falls back to clearly-labelled deterministic mock data if the network is unavailable.
 */
const CITIES: Record<string, { name: string; lat: number; lon: number }> = {
  tokyo: { name: "Tokyo", lat: 35.6895, lon: 139.6917 },
  osaka: { name: "Osaka", lat: 34.6937, lon: 135.5023 },
  kyoto: { name: "Kyoto", lat: 35.0116, lon: 135.7681 },
  nagoya: { name: "Nagoya", lat: 35.1815, lon: 136.9066 },
  sapporo: { name: "Sapporo", lat: 43.0618, lon: 141.3545 },
  fukuoka: { name: "Fukuoka", lat: 33.5904, lon: 130.4017 },
  naha: { name: "Naha", lat: 26.2124, lon: 127.6809 },
  東京: { name: "Tokyo", lat: 35.6895, lon: 139.6917 },
  大阪: { name: "Osaka", lat: 34.6937, lon: 135.5023 },
  京都: { name: "Kyoto", lat: 35.0116, lon: 135.7681 },
};

export class UnknownCityError extends Error {}

async function resolveCity(input: string) {
  const key = input.trim().toLowerCase();
  if (CITIES[key]) return CITIES[key];
  try {
    const r = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input)}&count=1&language=en`,
    );
    const g = r?.results?.[0];
    if (g) return { name: g.name as string, lat: g.latitude as number, lon: g.longitude as number };
  } catch {
    /* ignore */
  }
  throw new UnknownCityError(`Unknown city: ${input}`);
}

async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const WMO: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "heavy rain showers",
  82: "violent rain showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

function seeded(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (n: number) => ((h = (h * 1103515245 + 12345) >>> 0) % 1000) / 1000 * n;
}

export async function getWeather(cityInput: string) {
  const c = await resolveCity(cityInput);
  try {
    const d = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max&timezone=Asia%2FTokyo&forecast_days=1`,
    );
    return {
      city: c.name,
      source: "open-meteo.com",
      observedAt: d.current.time,
      current: {
        temperatureC: d.current.temperature_2m,
        feelsLikeC: d.current.apparent_temperature,
        humidityPct: d.current.relative_humidity_2m,
        precipitationMm: d.current.precipitation,
        windKmh: d.current.wind_speed_10m,
        condition: WMO[d.current.weather_code] ?? `code ${d.current.weather_code}`,
      },
      today: {
        maxC: d.daily.temperature_2m_max[0],
        minC: d.daily.temperature_2m_min[0],
        precipitationProbabilityPct: d.daily.precipitation_probability_max[0],
        uvIndexMax: d.daily.uv_index_max[0],
      },
    };
  } catch {
    const r = seeded(c.name);
    return {
      city: c.name,
      source: "mock (Open-Meteo unreachable)",
      current: { temperatureC: 15 + Math.round(r(10)), humidityPct: 40 + Math.round(r(40)), windKmh: Math.round(r(25)), condition: "partly cloudy" },
      today: { precipitationProbabilityPct: Math.round(r(100)) },
    };
  }
}

export async function getAirQuality(cityInput: string) {
  const c = await resolveCity(cityInput);
  try {
    const d = await fetchJson(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${c.lat}&longitude=${c.lon}` +
        `&current=pm2_5,pm10,us_aqi,european_aqi,ozone&timezone=Asia%2FTokyo`,
    );
    return {
      city: c.name,
      source: "open-meteo.com (air quality)",
      observedAt: d.current.time,
      pm2_5: d.current.pm2_5,
      pm10: d.current.pm10,
      ozone: d.current.ozone,
      usAqi: d.current.us_aqi,
      europeanAqi: d.current.european_aqi,
    };
  } catch {
    const r = seeded(c.name + "aq");
    return { city: c.name, source: "mock (Open-Meteo unreachable)", pm2_5: Math.round(r(30)), usAqi: Math.round(r(80)) };
  }
}

export async function getPremiumReport(cityInput: string) {
  const c = await resolveCity(cityInput);
  const d = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
      `&hourly=temperature_2m,precipitation_probability,wind_speed_10m&timezone=Asia%2FTokyo&forecast_days=2`,
  ).catch(() => null);
  return { city: c.name, source: d ? "open-meteo.com" : "mock", hourly: d?.hourly ?? null };
}
