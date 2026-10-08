// 기상청 단기예보 API → docs/index.html, docs/data.json 생성
// 사용: KMA_SERVICE_KEY=... node scripts/update.mjs   (테스트용: node scripts/update.mjs --mock)
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const OUT = new URL('docs/', ROOT);
const MOCK = process.argv.includes('--mock');
const API = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';

const config = JSON.parse(await readFile(new URL('config.json', ROOT), 'utf8'));

// ---------- 시간 유틸 (모든 계산은 KST 기준, Date의 UTC 필드를 KST로 사용) ----------
const pad = (n) => String(n).padStart(2, '0');
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

// 단기예보: 02,05,...,23시 발표, 약 10분 뒤 제공
function vilageBase(now) {
  const t = new Date(now.getTime() - 10 * 60e3);
  let h = [23, 20, 17, 14, 11, 8, 5, 2].find((x) => x <= t.getUTCHours());
  if (h === undefined) {
    t.setUTCDate(t.getUTCDate() - 1);
    h = 23;
  }
  return { base_date: ymd(t), base_time: `${pad(h)}00` };
}

// 초단기실황: 매시 정각 기준, 약 40분 뒤 제공
function ncstBase(now) {
  const t = new Date(now.getTime() - 40 * 60e3);
  return { base_date: ymd(t), base_time: `${pad(t.getUTCHours())}00` };
}

// ---------- 위경도 → 기상청 격자 (기상청 공식 LCC 변환) ----------
function toGrid(lat, lon) {
  const D = Math.PI / 180;
  const re = 6371.00877 / 5.0;
  const slat1 = 30 * D, slat2 = 60 * D, olon = 126 * D, olat = 38 * D;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  const sf = (Math.pow(Math.tan(Math.PI * 0.25 + slat1 * 0.5), sn) * Math.cos(slat1)) / sn;
  const ro = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  const ra = (re * sf) / Math.pow(Math.tan(Math.PI * 0.25 + lat * D * 0.5), sn);
  let theta = lon * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + 43 + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + 136 + 0.5),
  };
}

// ---------- API 호출 ----------
function serviceKey() {
  const key = (process.env.KMA_SERVICE_KEY || '').trim();
  if (!key) throw new Error('KMA_SERVICE_KEY 환경변수(GitHub Secret)가 비어 있습니다.');
  // 공공데이터포털 "Encoding" 키를 넣어도 이중 인코딩되지 않도록 디코딩
  return key.includes('%') ? decodeURIComponent(key) : key;
}

async function callPage(op, params, pageNo) {
  const qs = new URLSearchParams({
    serviceKey: serviceKey(),
    pageNo: String(pageNo),
    numOfRows: '1000',
    dataType: 'JSON',
    ...params,
  });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}/${op}?${qs}`, { signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        // 인증키 오류 등은 JSON 요청이어도 XML로 응답됨
        throw new Error(`${op} 응답이 JSON이 아닙니다 (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }
      const header = json?.response?.header;
      if (header?.resultCode !== '00') {
        throw new Error(`${op} 오류 ${header?.resultCode}: ${header?.resultMsg}`);
      }
      return json.response.body;
    } catch (e) {
      lastErr = e;
      console.warn(`[${attempt}/3] ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr;
}

async function callApi(op, params) {
  const items = [];
  for (let page = 1; page <= 5; page++) {
    const body = await callPage(op, params, page);
    const got = body?.items?.item ?? [];
    items.push(...got);
    if (!got.length || items.length >= Number(body.totalCount)) break;
  }
  return items;
}

// ---------- 테스트용 가짜 데이터 (API와 같은 형식) ----------
function mockFcst(base, grid, seed) {
  const fcst = [];
  const start = new Date(Date.UTC(+base.base_date.slice(0, 4), +base.base_date.slice(4, 6) - 1, +base.base_date.slice(6, 8), +base.base_time.slice(0, 2) + 1));
  for (let i = 0; i < 80; i++) {
    const t = new Date(start.getTime() + i * 3600e3);
    const h = t.getUTCHours();
    const add = (category, fcstValue) =>
      fcst.push({ category, fcstDate: ymd(t), fcstTime: `${pad(h)}00`, fcstValue: String(fcstValue), ...grid });
    const temp = Math.round(14 + seed + 7 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + (i > 40 ? -3 : 0));
    const rainy = i >= 30 + seed * 3 && i <= 38 + seed * 3;
    add('TMP', temp);
    add('SKY', rainy ? 4 : (i + seed) % 17 < 6 ? 3 : 1);
    add('PTY', rainy ? 1 : 0);
    add('POP', rainy ? 70 : (i + seed) % 17 < 6 ? 30 : 0);
    add('PCP', rainy ? '1.0mm' : '강수없음');
    add('REH', 55 + (h % 7) * 4);
    add('WSD', (1.2 + (h % 5) * 0.6).toFixed(1));
    if (h === 6) add('TMN', temp);
    if (h === 15) add('TMX', temp);
  }
  return fcst;
}
const mockNcst = (seed) =>
  [['T1H', 15.3 + seed], ['RN1', 0], ['REH', 62], ['WSD', 1.8], ['PTY', 0]].map(([category, obsrValue]) => ({ category, obsrValue: String(obsrValue) }));

// ---------- 데이터 가공 ----------
const PTY = { 1: '비', 2: '비/눈', 3: '눈', 4: '소나기', 5: '빗방울', 6: '빗방울/눈날림', 7: '눈날림' };
const SKY = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const describe = (sky, pty) => (pty && pty !== '0' ? PTY[pty] ?? '강수' : SKY[sky] ?? '-');

function icon(sky, pty, hour) {
  if (pty && pty !== '0') return { 1: '🌧️', 2: '🌨️', 3: '❄️', 4: '🌦️', 5: '🌦️', 6: '🌨️', 7: '❄️' }[pty] ?? '🌧️';
  const night = hour !== undefined && (hour < 6 || hour >= 19);
  return { 1: night ? '🌙' : '☀️', 3: night ? '☁️' : '⛅', 4: '☁️' }[sky] ?? '·';
}

const mode = (arr) => {
  const c = {};
  for (const v of arr) c[v] = (c[v] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
};

// 최신 발표를 우선하고, 빠진 시각(오늘 지난 시간·오늘 최저기온 등)은 이른 발표로 채움
function mergeFcst(latest, earlier) {
  const key = (it) => it.category + it.fcstDate + it.fcstTime;
  const seen = new Set(latest.map(key));
  return [...latest, ...earlier.filter((it) => !seen.has(key(it)))];
}

function build(loc, grid, fcstItems, ncstItems, now, base) {
  const slots = new Map(); // "YYYYMMDDHHMM" -> {cat: value}
  const tmn = {}, tmx = {};
  for (const it of fcstItems) {
    if (it.category === 'TMN') tmn[it.fcstDate] = Number(it.fcstValue);
    else if (it.category === 'TMX') tmx[it.fcstDate] = Number(it.fcstValue);
    const k = it.fcstDate + it.fcstTime;
    if (!slots.has(k)) slots.set(k, { date: it.fcstDate, hour: Number(it.fcstTime.slice(0, 2)) });
    slots.get(k)[it.category] = it.fcstValue;
  }
  const all = [...slots.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v).filter((s) => s.TMP !== undefined);

  const today = ymd(now);
  const nowKey = today + pad(now.getUTCHours()) + '00';
  const upcoming = all.filter((s) => s.date + pad(s.hour) + '00' >= nowKey);

  const hourly = upcoming.slice(0, 24).map((s) => ({
    date: s.date,
    hour: s.hour,
    temp: Number(s.TMP),
    sky: s.SKY,
    pty: s.PTY,
    pop: Number(s.POP ?? 0),
    pcp: s.PCP && s.PCP !== '강수없음' ? s.PCP : null,
  }));

  const byDate = new Map();
  for (const s of all) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  const daily = [...byDate.entries()]
    // 오늘 이후, 그리고 마지막 날처럼 몇 시간만 있는 날은 제외
    .filter(([d, list]) => d === today || (d > today && (list.length >= 18 || (tmn[d] !== undefined && tmx[d] !== undefined))))
    .map(([date, list]) => {
      const temps = list.map((s) => Number(s.TMP));
      const part = (from, to) => {
        const p = list.filter((s) => s.hour >= from && s.hour <= to);
        if (!p.length) return null;
        const wet = p.find((s) => s.PTY && s.PTY !== '0');
        const sky = mode(p.map((s) => s.SKY));
        const pty = wet ? wet.PTY : '0';
        return { sky, pty, text: describe(sky, pty), pop: Math.max(...p.map((s) => Number(s.POP ?? 0))) };
      };
      return {
        date,
        min: tmn[date] ?? Math.min(...temps),
        max: tmx[date] ?? Math.max(...temps),
        am: part(0, 11),
        pm: part(12, 23),
      };
    });

  const ncst = Object.fromEntries((ncstItems || []).map((it) => [it.category, it.obsrValue]));
  const cur = upcoming[0] || all[all.length - 1];
  const pty = ncst.PTY ?? cur.PTY;
  return {
    id: loc.id,
    name: loc.name,
    detail: loc.detail,
    lat: loc.lat,
    lon: loc.lon,
    ...grid,
    issuedAt: `${base.base_date.slice(4, 6)}/${base.base_date.slice(6, 8)} ${base.base_time.slice(0, 2)}:00`,
    current: {
      temp: Number(ncst.T1H ?? cur.TMP),
      sky: cur.SKY,
      pty,
      text: describe(cur.SKY, pty),
      reh: Number(ncst.REH ?? cur.REH),
      wsd: Number(ncst.WSD ?? cur.WSD),
      pop: Number(cur.POP ?? 0),
      rn1: ncst.RN1 && ncst.RN1 !== '0' && ncst.RN1 !== '강수없음' ? ncst.RN1 : null,
      observed: Boolean(ncstItems),
    },
    hourly,
    daily,
  };
}

async function fetchLocation(loc, now, index) {
  const grid = toGrid(loc.lat, loc.lon);
  const vBase = vilageBase(now);
  // 오늘 02시 발표: 오늘 최저기온(TMN)과 오늘 지난 시간대를 채우는 용도
  const earlyBase = { base_date: ymd(now), base_time: '0200' };
  const needEarly = vBase.base_date === earlyBase.base_date && vBase.base_time !== '0200';
  console.log(`${loc.name} → 격자 nx=${grid.nx}, ny=${grid.ny} / 단기예보 ${vBase.base_date} ${vBase.base_time}`);

  let latest, early = [], ncst = null;
  if (MOCK) {
    latest = mockFcst(vBase, grid, index * 2);
    if (needEarly) early = mockFcst(earlyBase, grid, index * 2);
    ncst = mockNcst(index * 2);
  } else {
    latest = await callApi('getVilageFcst', { ...vBase, ...grid });
    if (needEarly) {
      try {
        early = await callApi('getVilageFcst', { ...earlyBase, ...grid });
      } catch (e) {
        console.warn(`${loc.name} 02시 발표 보조자료 실패, 생략: ${e.message}`);
      }
    }
    try {
      ncst = await callApi('getUltraSrtNcst', { ...ncstBase(now), ...grid });
    } catch (e) {
      console.warn(`${loc.name} 초단기실황 실패, 예보값으로 대체: ${e.message}`);
    }
  }
  return build(loc, grid, mergeFcst(latest, early), ncst, now, vBase);
}

// ---------- HTML ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function dayLabel(date, today) {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
  const t = new Date(Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8)));
  const diff = Math.round((d - t) / 86400e3);
  return { rel: ['오늘', '내일', '모레', '글피'][diff] ?? `${DOW[d.getUTCDay()]}요일`, md: `${+date.slice(4, 6)}.${+date.slice(6, 8)} ${DOW[d.getUTCDay()]}` };
}

function renderPanel(loc, today, nowHour) {
  const c = loc.current;
  const td = loc.daily[0];
  const hourly = loc.hourly
    .map((h, i) => {
      const newDay = i > 0 && h.hour === 0;
      const label = i === 0 ? '지금' : newDay ? `${+h.date.slice(6, 8)}일` : `${h.hour}시`;
      return `<li class="h${newDay ? ' nd' : ''}${i === 0 ? ' now' : ''}">
          <span class="hh">${label}</span>
          <span class="hi" role="img" aria-label="${esc(describe(h.sky, h.pty))}">${icon(h.sky, h.pty, h.hour)}</span>
          <span class="ht">${i === 0 ? Math.round(c.temp) : h.temp}°</span>
          <span class="hp${h.pop >= 60 ? ' strong' : ''}">${h.pop ? `${h.pop}%` : ''}</span>
        </li>`;
    })
    .join('');
  const half = (p) =>
    p
      ? `<span class="half"><span class="di" role="img" aria-label="${esc(p.text)}">${icon(p.sky, p.pty, 12)}</span><span class="dp${p.pop >= 60 ? ' strong' : ''}">${p.pop ? `${p.pop}%` : ''}</span></span>`
      : '<span class="half"><span class="di dim">·</span><span class="dp"></span></span>';
  const daily = loc.daily
    .map((d) => {
      const l = dayLabel(d.date, today);
      return `<li class="d">
          <span class="dl"><b>${l.rel}</b><small>${l.md}</small></span>
          ${half(d.am)}${half(d.pm)}
          <span class="mm"><span class="lo">${d.min}°</span><span class="hi-t">${d.max}°</span></span>
        </li>`;
    })
    .join('');

  return `<section class="panel" id="p-${esc(loc.id)}" aria-label="${esc(loc.name)} 날씨">
    <div class="hero">
      <p class="place">${esc(loc.name)} <small>${esc(loc.detail)}</small></p>
      <div class="ic-big" role="img" aria-label="${esc(c.text)}">${icon(c.sky, c.pty, nowHour)}</div>
      <p class="temp">${c.temp}<span>°</span></p>
      <p class="desc">${esc(c.text)}</p>
      ${td ? `<p class="range">최저 <b class="lo">${td.min}°</b><i></i>최고 <b class="hi-t">${td.max}°</b></p>` : ''}
    </div>

    <div class="stats">
      <div><small>습도</small><b>${c.reh}%</b></div>
      <div><small>바람</small><b>${c.wsd}<em>m/s</em></b></div>
      ${c.rn1
        ? `<div><small>1시간 강수</small><b>${esc(String(c.rn1).replace(/\s*mm$/, ''))}<em>mm</em></b></div>`
        : `<div><small>강수확률</small><b>${c.pop}%</b></div>`}
    </div>

    <h2>시간별</h2>
    <ul class="hours">${hourly}</ul>

    <h2>날짜별 <small>오전 · 오후</small></h2>
    <ul class="days">${daily}</ul>

    <p class="src">기상청 ${esc(loc.issuedAt)} 발표 · 격자 ${loc.nx}, ${loc.ny}</p>
  </section>`;
}

function render(data, today, nowHour) {
  const tabs = data.locations
    .map((l, i) => `<button role="tab" type="button" data-i="${i}" aria-selected="${i === 0}" aria-controls="p-${esc(l.id)}">${esc(l.name)}</button>`)
    .join('');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<meta name="color-scheme" content="light">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${esc(data.title)}">
<meta name="format-detection" content="telephone=no">
<title>${esc(data.title)}</title>
<style>
:root{--bg:#fff;--text:#191f28;--sub:#4e5968;--muted:#8b95a1;--faint:#b0b8c1;--line:#f2f4f6;--chip:#f9fafb;--blue:#3182f6;--red:#f04452}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;letter-spacing:-.01em}
ul{list-style:none;margin:0;padding:0}
p{margin:0}
.top{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.88);-webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);padding:calc(env(safe-area-inset-top) + 10px) 16px 10px}
.tabs{display:flex;background:#f2f4f6;border-radius:12px;padding:3px;max-width:420px;margin:0 auto}
.tabs button{flex:1;border:0;background:transparent;font:inherit;font-size:15px;font-weight:600;color:var(--muted);padding:9px 0;border-radius:9px;cursor:pointer;transition:background .2s,color .2s,box-shadow .2s}
.tabs button[aria-selected="true"]{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.pager{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;align-items:flex-start;overscroll-behavior-x:contain}
.pager::-webkit-scrollbar{display:none}
.panel{scroll-margin-top:90px;flex:0 0 100%;width:100%;scroll-snap-align:start;scroll-snap-stop:always;padding:4px 16px calc(env(safe-area-inset-bottom) + 28px);max-width:100%}
.panel>*{max-width:560px;margin-left:auto;margin-right:auto}
.hero{text-align:center;padding:18px 0 22px}
.place{font-size:17px;font-weight:700}
.place small{display:block;font-size:12px;font-weight:500;color:var(--muted);margin-top:1px}
.ic-big{font-size:64px;line-height:1;margin:16px 0 6px}
.temp{font-size:76px;font-weight:200;line-height:1;letter-spacing:-.04em;margin-left:.15em;font-variant-numeric:tabular-nums}
.temp span{font-weight:200;color:var(--sub)}
.desc{font-size:18px;font-weight:600;margin-top:10px}
.range{color:var(--muted);font-size:14px;margin-top:4px}
.range b{font-weight:600}
.range i{display:inline-block;width:1px;height:10px;background:#d1d6db;margin:0 9px;vertical-align:-1px}
.lo{color:var(--blue)}.hi-t{color:var(--red)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);background:var(--chip);border-radius:16px;padding:14px 4px}
.stats div{display:flex;flex-direction:column;align-items:center;gap:2px}
.stats div+div{border-left:1px solid #eceef1}
.stats small{font-size:12px;color:var(--muted)}
.stats b{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
.stats em{font-style:normal;font-size:12px;font-weight:500;color:var(--muted);margin-left:2px}
h2{font-size:15px;font-weight:700;margin-top:28px;margin-bottom:10px}
h2 small{font-size:12px;font-weight:500;color:var(--muted);margin-left:4px}
.hours{display:flex;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:0 10px;overscroll-behavior-x:contain;-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%)}
.hours::-webkit-scrollbar{display:none}
.h{flex:0 0 54px;display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 0;border-radius:14px}
.h.now{background:var(--chip)}
.h.nd{position:relative}
.h.nd::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:1px;background:#e5e8eb}
.hh{font-size:12px;color:var(--muted);font-weight:500}
.h.now .hh{color:var(--text);font-weight:700}
.hi{font-size:24px;line-height:1.15}
.ht{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.hp{font-size:11px;color:var(--blue);min-height:15px;font-variant-numeric:tabular-nums}
.strong{font-weight:700}
.d{display:grid;grid-template-columns:1fr 64px 64px 84px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}
.d:first-child{border-top:0}
.dl{display:flex;flex-direction:column;line-height:1.25}
.dl b{font-size:15px;font-weight:600}
.dl small{font-size:12px;color:var(--muted)}
.half{display:flex;align-items:center;gap:3px;justify-content:center}
.di{font-size:22px;line-height:1}
.dim{color:var(--faint)}
.dp{font-size:11px;color:var(--blue);width:26px;font-variant-numeric:tabular-nums}
.mm{display:flex;justify-content:flex-end;gap:10px;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.src{font-size:11px;color:var(--faint);text-align:center;margin-top:24px}
footer{text-align:center;font-size:12px;color:var(--muted);padding:0 16px calc(env(safe-area-inset-bottom) + 20px)}
.dots{display:flex;justify-content:center;gap:6px;margin:2px 0 10px}
.dots span{width:6px;height:6px;border-radius:50%;background:#d1d6db;transition:background .2s,width .2s}
.dots span.on{background:var(--text);width:16px;border-radius:3px}
@media (min-width:700px){.hours{margin:0;padding:0;-webkit-mask-image:none;mask-image:none}}
</style>
</head>
<body>
<div class="top"><nav class="tabs" role="tablist" aria-label="지역">${tabs}</nav></div>
<main class="pager" id="pager">
${data.locations.map((l) => renderPanel(l, today, nowHour)).join('\n')}
</main>
<footer>
  <div class="dots" aria-hidden="true">${data.locations.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('')}</div>
  ${esc(data.updatedAt)} 업데이트 · 자료 기상청
</footer>
<script>
(() => {
  const pager = document.getElementById('pager');
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const dots = [...document.querySelectorAll('.dots span')];
  const ids = tabs.map((t) => t.getAttribute('aria-controls').slice(2));
  let cur = -1;
  const mark = (i) => {
    if (i === cur) return;
    cur = i;
    tabs.forEach((t, j) => t.setAttribute('aria-selected', String(j === i)));
    dots.forEach((d, j) => d.classList.toggle('on', j === i));
    try { localStorage.setItem('tab', ids[i]); } catch (e) {}
    history.replaceState(null, '', '#' + ids[i]);
  };
  const go = (i, smooth) => {
    pager.scrollTo({ left: i * pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    mark(i);
  };
  tabs.forEach((t, i) => t.addEventListener('click', () => {
    if (i === cur) window.scrollTo({ top: 0, behavior: 'smooth' });
    go(i, true);
  }));
  let raf;
  pager.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => mark(Math.round(pager.scrollLeft / pager.clientWidth)));
  }, { passive: true });
  addEventListener('resize', () => go(cur, false));
  let saved = location.hash.slice(1);
  if (!ids.includes(saved)) { try { saved = localStorage.getItem('tab'); } catch (e) {} }
  go(Math.max(0, ids.indexOf(saved)), false);
})();
</script>
</body>
</html>
`;
}

// ---------- 실행 ----------
const now = kstNow();
const locations = [];
for (const [i, loc] of config.locations.entries()) locations.push(await fetchLocation(loc, now, i));

const data = {
  title: config.title,
  updatedAt: `${+(now.getUTCMonth() + 1)}월 ${now.getUTCDate()}일 ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`,
  locations,
};
await mkdir(OUT, { recursive: true });
await writeFile(new URL('data.json', OUT), JSON.stringify(data, null, 2) + '\n');
await writeFile(new URL('index.html', OUT), render(data, ymd(now), now.getUTCHours()));
await writeFile(new URL('.nojekyll', OUT), '');
for (const l of locations) console.log(`완료 ${l.name}: ${l.current.temp}° ${l.current.text}, 시간별 ${l.hourly.length}개, 날짜별 ${l.daily.length}일`);
