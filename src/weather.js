/**
 * weather.js — current weather + tomorrow's forecast + change alerts.
 *
 * Data source: Open-Meteo (https://open-meteo.com/), free, no API key.
 * Defaults to the BUPT 西土城 campus (Beijing); override `weather.latitude` /
 * `weather.longitude` / `weather.city` in config.json for another place.
 *
 * What the digest gets:
 *   - current conditions (temperature, feels-like, humidity, wind, sky);
 *   - today's and tomorrow's forecast (sky, high/low, precipitation chance);
 *   - alerts derived from the recent change, e.g. 明天降温 / 明天大降温 /
 *     明天降雨 / 明天降雪 / 明天大风 / 夜间跌破 0°C.
 *
 * Strictly best-effort: a network failure returns { ok:false } and the caller
 * logs a warning — the notices must never be lost because the weather timed out.
 */

import { log } from './logger.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_TIMEOUT_MS = 10000;

/** WMO weather interpretation codes → text / emoji / kind. */
const WMO = {
  0: { text: '晴', icon: '☀️', kind: 'sun' },
  1: { text: '大部晴朗', icon: '🌤️', kind: 'sun' },
  2: { text: '多云', icon: '⛅', kind: 'cloud' },
  3: { text: '阴', icon: '☁️', kind: 'cloud' },
  45: { text: '雾', icon: '🌫️', kind: 'fog' },
  48: { text: '冻雾', icon: '🌫️', kind: 'fog' },
  51: { text: '小毛毛雨', icon: '🌦️', kind: 'rain' },
  53: { text: '毛毛雨', icon: '🌦️', kind: 'rain' },
  55: { text: '大毛毛雨', icon: '🌧️', kind: 'rain' },
  56: { text: '冻毛毛雨', icon: '🌧️', kind: 'rain' },
  57: { text: '强冻毛毛雨', icon: '🌧️', kind: 'rain' },
  61: { text: '小雨', icon: '🌦️', kind: 'rain' },
  63: { text: '中雨', icon: '🌧️', kind: 'rain' },
  65: { text: '大雨', icon: '🌧️', kind: 'rain' },
  66: { text: '冻雨', icon: '🌧️', kind: 'rain' },
  67: { text: '强冻雨', icon: '🌧️', kind: 'rain' },
  71: { text: '小雪', icon: '🌨️', kind: 'snow' },
  73: { text: '中雪', icon: '🌨️', kind: 'snow' },
  75: { text: '大雪', icon: '❄️', kind: 'snow' },
  77: { text: '雪粒', icon: '🌨️', kind: 'snow' },
  80: { text: '小阵雨', icon: '🌦️', kind: 'rain' },
  81: { text: '阵雨', icon: '🌧️', kind: 'rain' },
  82: { text: '强阵雨', icon: '⛈️', kind: 'rain' },
  85: { text: '小阵雪', icon: '🌨️', kind: 'snow' },
  86: { text: '大阵雪', icon: '❄️', kind: 'snow' },
  95: { text: '雷阵雨', icon: '⛈️', kind: 'storm' },
  96: { text: '雷阵雨伴冰雹', icon: '⛈️', kind: 'storm' },
  99: { text: '强雷阵雨伴冰雹', icon: '⛈️', kind: 'storm' },
};

export function describeCode(code) {
  return WMO[Number(code)] || { text: `天气代码 ${code}`, icon: '🌡️', kind: 'other' };
}

/** Compass text for a wind direction in degrees. */
export function windDirection(deg) {
  if (deg === null || deg === undefined || Number.isNaN(Number(deg))) return '';
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return dirs[Math.round(((Number(deg) % 360) + 360) % 360 / 45) % 8] + '风';
}

/** m/s → 蒲福风级 (0–12). */
export function windLevel(ms) {
  const t = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let lvl = 0;
  while (lvl < t.length && Number(ms) >= t[lvl]) lvl += 1;
  return lvl;
}

/** Precipitation kinds, ordered by how loudly they should be announced. */
const KIND_NAME = { storm: '雷阵雨', snow: '降雪', rain: '降雨' };

/**
 * Build the alert lines by comparing today with tomorrow.
 *
 * Thresholds follow common practice:
 *   - 最高气温下降 ≥ 4°C → 降温；≥ 8°C → 大降温（升温同理）
 *   - 明天出现雨/雪/雷阵雨而今天没有 → 明天有降雨/降雪/雷阵雨
 *   - 明天最低气温跌破 0°C 而今天没有 → 注意防寒防滑
 *   - 明天最大风力 ≥ 6 级（10.8 m/s）→ 大风提醒
 *
 * @returns {string[]} possibly empty
 */
export function buildAlerts(today, tomorrow) {
  if (!today || !tomorrow) return [];
  const alerts = [];

  const drop = num(today.tmax) - num(tomorrow.tmax);
  if (drop >= 8) alerts.push(`明天大降温，最高气温直降 ${Math.round(drop)}°C，注意添衣保暖`);
  else if (drop >= 4) alerts.push(`明天降温，最高气温下降 ${Math.round(drop)}°C，出门多带件外套`);
  else if (drop <= -8) alerts.push(`明天大幅升温，最高气温升高 ${Math.round(-drop)}°C`);
  else if (drop <= -4) alerts.push(`明天升温，最高气温升高 ${Math.round(-drop)}°C`);

  // New precipitation tomorrow that today does not have.
  const todayKind = today.kind;
  const tomorrowKind = tomorrow.kind;
  const precip = (k) => k === 'rain' || k === 'snow' || k === 'storm';
  if (precip(tomorrowKind) && !precip(todayKind)) {
    alerts.push(`明天有${KIND_NAME[tomorrowKind] || '降水'}（${tomorrow.text}），记得带伞/注意出行`);
  } else if (precip(tomorrowKind) && tomorrowKind !== todayKind && KIND_NAME[tomorrowKind]) {
    alerts.push(`明天转为${KIND_NAME[tomorrowKind]}（${tomorrow.text}）`);
  }

  if (num(tomorrow.tmin) <= 0 && num(today.tmin) > 0) {
    alerts.push(`明天夜间最低气温跌破 0°C（${Math.round(num(tomorrow.tmin))}°C），注意防寒防滑`);
  }

  if (num(tomorrow.windMax) >= 10.8 && num(today.windMax) < 10.8) {
    alerts.push(`明天风力加大（最大 ${windLevel(num(tomorrow.windMax))} 级），注意防风`);
  }

  return alerts;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** One day's forecast, normalised. */
function dayEntry(code, tmax, tmin, precipProb, windMax) {
  const d = describeCode(code);
  return {
    code: Number(code),
    text: d.text,
    icon: d.icon,
    kind: d.kind,
    tmax: tmax === null || tmax === undefined ? null : Number(tmax),
    tmin: tmin === null || tmin === undefined ? null : Number(tmin),
    precipProb: precipProb === null || precipProb === undefined ? null : Number(precipProb),
    windMax: windMax === null || windMax === undefined ? null : Number(windMax),
  };
}

/**
 * Fetch current weather + today/tomorrow forecasts.
 *
 * @param {object} cfg the loaded configuration (`cfg.weather`)
 * @param {{token?:object, fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, error?:string, city?:string, current?:object,
 *                    today?:object, tomorrow?:object, alerts?:string[], fetchedAt?:string}>}
 */
export async function fetchWeather(cfg, { token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const w = cfg.weather || {};
  const city = w.city || '北京';
  const lat = Number(w.latitude ?? 39.96);
  const lon = Number(w.longitude ?? 116.36);
  const fetchedAt = new Date().toISOString();

  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max',
    forecast_days: '2',
    timezone: 'Asia/Shanghai',
    wind_speed_unit: 'ms',
  });
  const url = `${API}?${qs}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Bridge the run's cancellation token into the HTTP request.
  const onCancel = () => controller.abort();
  token?.signal?.addEventListener?.('abort', onCancel, { once: true });

  let data;
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    const msg = err.name === 'AbortError' ? `请求超时（${timeoutMs / 1000} 秒）` : err.message;
    log.warn(`获取天气失败：${msg}`);
    return { ok: false, error: msg, city, fetchedAt };
  } finally {
    clearTimeout(timer);
    token?.signal?.removeEventListener?.('abort', onCancel);
  }

  const c = data.current;
  const d = data.daily;
  if (!c || !d?.time?.length) {
    log.warn('获取天气失败：接口返回缺少 current/daily 数据');
    return { ok: false, error: '接口返回格式异常', city, fetchedAt };
  }

  const cur = describeCode(c.weather_code);
  const current = {
    temp: c.temperature_2m === null || c.temperature_2m === undefined ? null : Number(c.temperature_2m),
    feelsLike:
      c.apparent_temperature === null || c.apparent_temperature === undefined
        ? null
        : Number(c.apparent_temperature),
    humidity:
      c.relative_humidity_2m === null || c.relative_humidity_2m === undefined
        ? null
        : Number(c.relative_humidity_2m),
    windSpeed: c.wind_speed_10m === null || c.wind_speed_10m === undefined ? null : Number(c.wind_speed_10m),
    windDir: windDirection(c.wind_direction_10m),
    code: Number(c.weather_code),
    text: cur.text,
    icon: cur.icon,
    kind: cur.kind,
  };

  const today = dayEntry(
    d.weather_code[0],
    d.temperature_2m_max[0],
    d.temperature_2m_min[0],
    d.precipitation_probability_max?.[0],
    d.wind_speed_10m_max?.[0],
  );
  const tomorrow = d.time.length > 1
    ? dayEntry(
        d.weather_code[1],
        d.temperature_2m_max[1],
        d.temperature_2m_min[1],
        d.precipitation_probability_max?.[1],
        d.wind_speed_10m_max?.[1],
      )
    : null;

  const alerts = buildAlerts(today, tomorrow);
  log.info(
    `天气：${city} 现在 ${fmtTemp(current.temp)} ${current.text}；明天 ${fmtTemp(tomorrow?.tmin)}~${fmtTemp(
      tomorrow?.tmax,
    )} ${tomorrow?.text || ''}${alerts.length ? `；提醒：${alerts.join('；')}` : ''}`,
  );
  return { ok: true, city, current, today, tomorrow, alerts, fetchedAt };
}

function fmtTemp(v) {
  return v === null || v === undefined ? '—' : `${Math.round(Number(v))}°C`;
}

/**
 * Human-readable summary lines for the digest / panel.
 *
 * @returns {{line:string, alerts:string[]}|null} null when nothing usable
 */
export function summarizeWeather(weather) {
  if (!weather || weather.ok !== true) return null;
  const { city, current, today, tomorrow, alerts = [] } = weather;
  if (!current) return null;

  const bits = [];
  const curBits = [`${current.icon} ${city} 现在 ${fmtTemp(current.temp)} ${current.text}`];
  if (current.feelsLike !== null && current.feelsLike !== undefined) {
    curBits.push(`体感 ${fmtTemp(current.feelsLike)}`);
  }
  if (current.humidity !== null && current.humidity !== undefined) {
    curBits.push(`湿度 ${Math.round(current.humidity)}%`);
  }
  if (current.windSpeed !== null && current.windSpeed !== undefined) {
    curBits.push(`${current.windDir || '风'} ${windLevel(current.windSpeed)} 级`);
  }
  bits.push(curBits.join('，'));

  const fmtDay = (label, day) => {
    if (!day) return null;
    const b = [`${day.icon} ${label} ${fmtTemp(day.tmin)}~${fmtTemp(day.tmax)} ${day.text}`];
    if (day.precipProb !== null && day.precipProb !== undefined && day.precipProb >= 20) {
      b.push(`降水概率 ${Math.round(day.precipProb)}%`);
    }
    return b.join('，');
  };
  const t = fmtDay('今天', today);
  const tm = fmtDay('明天', tomorrow);
  if (t) bits.push(t);
  if (tm) bits.push(tm);

  // `lines` 每条信息单独一行（邮件/摘要里分行显示）；`line` 供事件日志等
  // 需要单行的场合使用。
  return { lines: bits, line: bits.join(' ｜ '), alerts, current, today, tomorrow, city };
}
