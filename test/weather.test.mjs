/**
 * weather.test.mjs — the weather block that rides along with forwarded mail.
 *
 * Covers:
 *   - WMO code mapping / wind helpers,
 *   - the change alerts (降温 / 大降温 / 升温 / 降雨 / 降雪 / 大风 / 跌破 0°C),
 *   - fetchWeather normalisation with an injected fetch (no real network),
 *   - the mail digest actually containing the weather block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCode,
  windDirection,
  windLevel,
  buildAlerts,
  fetchWeather,
  summarizeWeather,
} from '../src/weather.js';
import { composeMail, composeEmptyMail } from '../src/mailer.js';

const CFG = {
  weather: { enabled: true, city: '北京', latitude: 39.96, longitude: 116.36 },
  email: { subjectPrefix: '[北邮通知]' },
  output: {},
  portal: {},
  windowDays: 10,
};

function day(tmax, tmin, code, { precipProb = 0, windMax = 5 } = {}) {
  const d = describeCode(code);
  return { code, text: d.text, icon: d.icon, kind: d.kind, tmax, tmin, precipProb, windMax };
}

test('describeCode maps known WMO codes and survives unknown ones', () => {
  assert.equal(describeCode(0).text, '晴');
  assert.equal(describeCode(61).kind, 'rain');
  assert.equal(describeCode(73).kind, 'snow');
  assert.equal(describeCode(95).kind, 'storm');
  const unknown = describeCode(1234);
  assert.equal(unknown.kind, 'other');
  assert.match(unknown.text, /1234/);
});

test('wind helpers: compass direction and Beaufort level', () => {
  assert.equal(windDirection(0), '北风');
  assert.equal(windDirection(90), '东风');
  assert.equal(windDirection(225), '西南风');
  assert.equal(windDirection(315), '西北风');
  assert.equal(windDirection(null), '');
  assert.equal(windLevel(0.2), 0);
  assert.equal(windLevel(3.0), 2);
  assert.equal(windLevel(10.8), 6);
  assert.equal(windLevel(35), 12);
});

test('buildAlerts: no alert for a calm, steady day', () => {
  const alerts = buildAlerts(day(20, 10, 1), day(19, 9, 2));
  assert.deepEqual(alerts, []);
});

test('buildAlerts: 明天降温 (>=4°C) and 明天大降温 (>=8°C)', () => {
  const mild = buildAlerts(day(20, 10, 1), day(15, 8, 2));
  assert.equal(mild.length, 1);
  assert.match(mild[0], /明天降温/);
  assert.match(mild[0], /5°C/);

  const hard = buildAlerts(day(20, 10, 1), day(10, 2, 3));
  assert.match(hard[0], /明天大降温/);
  assert.match(hard[0], /10°C/);
});

test('buildAlerts: 升温 warnings', () => {
  const warm = buildAlerts(day(10, 2, 3), day(15, 6, 1));
  assert.match(warm[0], /明天升温/);
  const hot = buildAlerts(day(10, 2, 3), day(20, 10, 1));
  assert.match(hot[0], /明天大幅升温/);
});

test('buildAlerts: 明天降雨 / 降雪 / 雷阵雨 when today is dry', () => {
  assert.match(buildAlerts(day(15, 5, 1), day(12, 4, 61)).join('\n'), /明天有降雨/);
  assert.match(buildAlerts(day(5, -1, 2), day(2, -3, 73)).join('\n'), /明天有降雪/);
  assert.match(buildAlerts(day(28, 20, 1), day(26, 19, 95)).join('\n'), /明天有雷阵雨/);
});

test('buildAlerts: 雨转雪 announces the change, 持续降雨 stays quiet', () => {
  assert.match(buildAlerts(day(8, 3, 61), day(3, -1, 73)).join('\n'), /转为降雪/);
  const steady = buildAlerts(day(8, 3, 61), day(7, 2, 63));
  assert.equal(steady.filter((a) => /降雨|降雪/.test(a)).length, 0);
});

test('buildAlerts: 夜间跌破 0°C and 大风', () => {
  assert.match(buildAlerts(day(10, 2, 1), day(8, -2, 2)).join('\n'), /跌破 0°C/);
  assert.match(
    buildAlerts(day(15, 5, 1, { windMax: 4 }), day(14, 4, 2, { windMax: 12 })).join('\n'),
    /风力加大（最大 6 级）/,
  );
});

test('buildAlerts tolerates missing input', () => {
  assert.deepEqual(buildAlerts(null, null), []);
  assert.deepEqual(buildAlerts(day(1, 0, 1), null), []);
});

/** Canned Open-Meteo reply: sunny & warm today, sharp cooling + snow tomorrow. */
function fakeFetch() {
  return async (url) => {
    assert.match(url, /api\.open-meteo\.com/);
    assert.match(url, /wind_speed_unit=ms/);
    return {
      ok: true,
      async json() {
        return {
          current: {
            temperature_2m: 18.4,
            relative_humidity_2m: 45,
            apparent_temperature: 17.1,
            weather_code: 1,
            wind_speed_10m: 3.2,
            wind_direction_10m: 315,
          },
          daily: {
            time: ['2026-10-20', '2026-10-21'],
            weather_code: [1, 73],
            temperature_2m_max: [20.3, 9.8],
            temperature_2m_min: [10.2, -1.5],
            precipitation_probability_max: [0, 70],
            wind_speed_10m_max: [4.0, 5.0],
          },
        };
      },
    };
  };
}

test('fetchWeather normalises current + today + tomorrow and derives alerts', async () => {
  const w = await fetchWeather(CFG, { fetchImpl: fakeFetch() });
  assert.equal(w.ok, true);
  assert.equal(w.city, '北京');
  assert.equal(w.current.temp, 18.4);
  assert.equal(w.current.text, '大部晴朗');
  assert.equal(w.current.windDir, '西北风');
  assert.equal(w.today.tmax, 20.3);
  assert.equal(w.tomorrow.kind, 'snow');
  assert.match(w.alerts.join('\n'), /明天大降温/);
  assert.match(w.alerts.join('\n'), /明天有降雪/);
  assert.match(w.alerts.join('\n'), /跌破 0°C/);
});

test('fetchWeather reports HTTP failure without throwing', async () => {
  const w = await fetchWeather(CFG, {
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(w.ok, false);
  assert.match(w.error, /502/);
});

test('fetchWeather reports malformed payloads without throwing', async () => {
  const w = await fetchWeather(CFG, {
    fetchImpl: async () => ({ ok: true, async json() { return {}; } }),
  });
  assert.equal(w.ok, false);
  assert.match(w.error, /格式/);
});

test('summarizeWeather formats one line plus alerts', async () => {
  const w = await fetchWeather(CFG, { fetchImpl: fakeFetch() });
  const sum = summarizeWeather(w);
  assert.match(sum.line, /北京 现在 18°C 大部晴朗/);
  assert.match(sum.line, /体感 17°C/);
  assert.match(sum.line, /湿度 45%/);
  assert.match(sum.line, /西北风 2 级/);
  assert.match(sum.line, /明天 -1°C~10°C 中雪/);
  assert.match(sum.line, /降水概率 70%/);
  assert.equal(sum.alerts.length, 3);
  // 三条信息各自单独成行
  assert.equal(sum.lines.length, 3);
  assert.match(sum.lines[0], /现在 18°C/);
  assert.match(sum.lines[1], /今天 10°C~20°C/);
  assert.match(sum.lines[2], /明天 -1°C~10°C 中雪/);
  assert.equal(summarizeWeather(null), null);
  assert.equal(summarizeWeather({ ok: false }), null);
});

function sampleWeather() {
  return {
    ok: true,
    city: '北京',
    fetchedAt: new Date().toISOString(),
    current: { temp: 18, feelsLike: 17, humidity: 45, windSpeed: 3.2, windDir: '西北风', text: '晴', icon: '☀️' },
    today: { tmax: 20, tmin: 10, text: '晴', icon: '☀️', kind: 'sun', precipProb: 0, windMax: 4 },
    tomorrow: { tmax: 10, tmin: -1, text: '中雪', icon: '🌨️', kind: 'snow', precipProb: 70, windMax: 5 },
    alerts: ['明天大降温，最高气温直降 10°C，注意添衣保暖', '明天有降雪（中雪），记得带伞/注意出行'],
  };
}

const ITEM = {
  title: '关于测试的通知',
  url: 'http://my.bupt.edu.cn/info/1.htm',
  source: '校内通知',
  date: '2026-10-20',
};

test('composeMail embeds the weather block in text and html', () => {
  const { text, html } = composeMail([ITEM], CFG, { now: new Date(), weather: sampleWeather() });
  assert.match(text, /【天气】☀️ 北京 现在 18°C 晴/);
  assert.match(text, /⚠️ 明天大降温/);
  assert.match(html, /明天有降雪/);
});

test('composeMail shows 现在/今天/明天 each on its own line', () => {
  const { text, html } = composeMail([ITEM], CFG, { now: new Date(), weather: sampleWeather() });
  // 纯文本：三条信息各占一行，后两行缩进对齐
  const weatherLines = text.split('\n').filter((l) => l.includes('°C'));
  assert.ok(weatherLines.length >= 3);
  assert.match(weatherLines[0], /^【天气】/);
  assert.match(weatherLines[1], /^\s+☀️ 今天/);
  assert.match(weatherLines[2], /^\s+🌨️ 明天/);
  // HTML：天气块内每条信息一个 <div>（三条信息 + 两条提醒）
  const blockLine = html.split('\n').find((l) => l.includes('background:#f0f9ff'));
  assert.ok(blockLine);
  const divCount = (blockLine.match(/<div[ >]/g) || []).length;
  assert.equal(divCount, 3 + 2 + 1); // 三条信息 + 两条提醒 + 外层容器
});

test('composeMail works without weather (disabled / fetch failed)', () => {
  const { text, html } = composeMail([ITEM], CFG, { now: new Date() });
  assert.doesNotMatch(text, /【天气】/);
  assert.doesNotMatch(html, /⚠️/);
});

test('composeEmptyMail also carries the weather block', () => {
  const { text, html } = composeEmptyMail(CFG, { now: new Date(), weather: sampleWeather() });
  assert.match(text, /【天气】/);
  assert.match(text, /明天大降温/);
  assert.match(html, /🌨️/);
});
