import { objectParams, ToolRegistry } from '../tools';

// 天气工具：基于 open-meteo（免 API key、无需鉴权）实现「地理编码 + 当前天气 + 多日预报」。
// 全部走 Node 全局 fetch（Node 18+ 内置），不引入任何外部依赖。
// 工具以 `builtin__` 前缀命名，护栏 / 记忆 / 追踪对其自动覆盖，与 calculator 等内置工具一致。

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather code → 人类可读描述（覆盖 open-meteo 返回的常用取值）。
const WEATHER_CODE: Record<number, string> = {
  0: '晴',
  1: '大致晴朗',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴大冰雹'
};

interface GeoHit {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

/** 把地名解析为经纬度（取匹配度最高的第一个结果）。空结果抛错。 */
async function geocode(location: string, signal?: AbortSignal): Promise<GeoHit> {
  const url = `${GEO_URL}?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocoding 请求失败 (${res.status})`);
  const json = (await res.json()) as { results?: GeoHit[] };
  const hit = json.results && json.results[0];
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
    throw new Error(`找不到地点：${location}`);
  }
  return hit;
}

/** 把 WMO code 映射为中文描述，未知则回退英文原文。 */
function describeCode(code: unknown): string {
  const n = Number(code);
  if (Number.isFinite(n) && WEATHER_CODE[n]) return WEATHER_CODE[n];
  return typeof code === 'number' ? `天气代码 ${code}` : String(code ?? '未知');
}

/**
 * 拉取某坐标的当前天气与多日预报。
 * @param days 预报天数（1-16），超出范围收敛到边界。
 * @param units 'metric'（摄氏/公里每小时/毫米）或 'imperial'（华氏/英里每小时/英寸）。
 */
async function fetchWeather(
  lat: number,
  lon: number,
  days: number,
  units: 'metric' | 'imperial',
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const forecastDays = Math.min(Math.max(days, 1), 16);
  const tempUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';
  const windUnit = units === 'imperial' ? 'mph' : 'kmh';
  const precipUnit = units === 'imperial' ? 'inch' : 'mm';
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,precipitation',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    forecast_days: String(forecastDays),
    temperature_unit: tempUnit,
    wind_speed_unit: windUnit,
    precipitation_unit: precipUnit,
    timezone: 'auto'
  });
  const url = `${FORECAST_URL}?${params.toString()}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`weather 请求失败 (${res.status})`);
  const json = (await res.json()) as any;
  if (!json || typeof json !== 'object') throw new Error('weather 响应解析失败');

  const cur = json.current ?? {};
  const daily = json.daily ?? {};
  const forecast: Array<Record<string, unknown>> = [];
  const dayCount = Array.isArray(daily.time) ? daily.time.length : 0;
  for (let i = 0; i < dayCount; i++) {
    forecast.push({
      date: daily.time[i],
      code: daily.weather_code?.[i],
      condition: describeCode(daily.weather_code?.[i]),
      tempMax: daily.temperature_2m_max?.[i],
      tempMin: daily.temperature_2m_min?.[i],
      precipProb: daily.precipitation_probability_max?.[i]
    });
  }

  return {
    location: { lat, lon, timezone: json.timezone },
    units,
    current: {
      temperature: cur.temperature_2m,
      apparent: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m,
      code: cur.weather_code,
      condition: describeCode(cur.weather_code),
      windSpeed: cur.wind_speed_10m,
      windDirection: cur.wind_direction_10m,
      precipitation: cur.precipitation
    },
    forecast
  };
}

export function registerWeather(registry: ToolRegistry): void {
  registry.register(
    'builtin__weather',
    'Get current weather and a multi-day forecast for a place (city / address). ' +
      'Powered by open-meteo (no API key needed). Use when the user asks about weather, ' +
      'temperature, rain, or "what to wear" for a location. ' +
      'Example: location="上海", days=3.',
    objectParams(
      {
        location: {
          type: 'string',
          description: 'Place name or address, e.g. "北京", "Shanghai", "Tokyo".'
        },
        days: {
          type: 'number',
          description: 'Forecast days, 1-16 (default 1 = current only).'
        },
        units: {
          type: 'string',
          enum: ['metric', 'imperial'],
          description: 'metric = Celsius/kmh/mm (default); imperial = Fahrenheit/mph/inch.'
        }
      },
      ['location']
    ),
    async (args: Record<string, unknown>) => {
      const location = args.location ? String(args.location).trim() : '';
      if (!location) return 'error: 缺少 location';
      const days =
        typeof args.days === 'number' && Number.isFinite(args.days)
          ? Math.floor(args.days)
          : 1;
      const units =
        args.units === 'imperial' ? 'imperial' : 'metric';
      try {
        const geo = await geocode(location);
        const weather = await fetchWeather(geo.latitude, geo.longitude, days, units);
        const place = [geo.name, geo.admin1, geo.country].filter(Boolean).join(', ');
        return JSON.stringify({ place, ...weather });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );
}
