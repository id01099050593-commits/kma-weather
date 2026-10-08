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

async function callApi(op, params) {
  const qs = new URLSearchParams({
    serviceKey: serviceKey(),
    pageNo: '1',
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
      return json.response.body.items.item;
    } catch (e) {
      lastErr = e;
      console.warn(`[${attempt}/3] ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr;
}

// ---------- 테스트용 가짜 데이터 (API와 같은 형식) ----------
function mockData(base, grid) {
  const fcst = [];
  const start = new Date(Date.UTC(+base.base_date.slice(0, 4), +base.base_date.slice(4, 6) - 1, +base.base_date.slice(6, 8), +base.base_time.slice(0, 2) + 1));
  for (let i = 0; i < 72; i++) {
    const t = new Date(start.getTime() + i * 3600e3);
    const h = t.getUTCHours();
    const add = (category, fcstValue) =>
      fcst.push({ category, fcstDate: ymd(t), fcstTime: `${pad(h)}00`, fcstValue: String(fcstValue), ...grid });
    const temp = Math.round(14 + 7 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + (i > 40 ? -3 : 0));
    const rainy = i >= 30 && i <= 38;
    add('TMP', temp);
    add('SKY', rainy ? 4 : i % 17 < 6 ? 3 : 1);
    add('PTY', rainy ? 1 : 0);
    add('POP', rainy ? 70 : i % 17 < 6 ? 30 : 0);
    add('PCP', rainy ? '1.0mm' : '강수없음');
    add('REH', 55 + (h % 7) * 4);
    add('WSD', (1.2 + (h % 5) * 0.6).toFixed(1));
    if (h === 6) add('TMN', temp);
    if (h === 15) add('TMX', temp);
  }
  const ncst = [
    ['T1H', 15.3], ['RN1', 0], ['REH', 62], ['WSD', 1.8], ['PTY', 0],
  ].map(([category, obsrValue]) => ({ category, obsrValue: String(obsrValue) }));
  return { fcst, ncst };
}

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

function build(fcstItems, ncstItems, now, base, grid) {
  const slots = new Map(); // "YYYYMMDDHHMM" -> {cat: value}
  const tmn = {}, tmx = {};
  for (const it of fcstItems) {
    if (it.category === 'TMN') tmn[it.fcstDate] = Number(it.fcstValue);
    else if (it.category === 'TMX') tmx[it.fcstDate] = Number(it.fcstValue);
    const k = it.fcstDate + it.fcstTime;
    if (!slots.has(k)) slots.set(k, { date: it.fcstDate, hour: Number(it.fcstTime.slice(0, 2)) });
    slots.get(k)[it.category] = it.fcstValue;
  }
  const all = [...slots.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);

  const nowKey = ymd(now) + pad(now.getUTCHours()) + '00';
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
    .filter(([d]) => d >= ymd(now))
    .map(([date, list]) => {
      const temps = list.map((s) => Number(s.TMP)).filter((n) => !Number.isNaN(n));
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
  const current = {
    temp: Number(ncst.T1H ?? cur.TMP),
    sky: cur.SKY,
    pty,
    text: describe(cur.SKY, pty),
    reh: Number(ncst.REH ?? cur.REH),
    wsd: Number(ncst.WSD ?? cur.WSD),
    rn1: ncst.RN1 && ncst.RN1 !== '0' && ncst.RN1 !== '강수없음' ? ncst.RN1 : null,
    observed: Boolean(ncstItems),
  };

  return {
    location: { name: config.name, lat: config.lat, lon: config.lon, ...grid },
    updatedAt: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`,
    issuedAt: `${base.base_date.slice(4, 6)}/${base.base_date.slice(6, 8)} ${base.base_time.slice(0, 2)}:00`,
    current,
    hourly,
    daily,
  };
}

// ---------- HTML ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function dayLabel(date, today) {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
  const t = new Date(Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8)));
  const diff = Math.round((d - t) / 86400e3);
  const rel = ['오늘', '내일', '모레', '글피'][diff] ?? '';
  return { rel, md: `${+date.slice(4, 6)}.${+date.slice(6, 8)} (${DOW[d.getUTCDay()]})` };
}

function render(data, today) {
  const c = data.current;
  const td = data.daily[0];
  const hourly = data.hourly
    .map((h, i) => {
      const newDay = i > 0 && h.hour === 0;
      return `<li class="h${newDay ? ' newday' : ''}">
        <span class="hh">${newDay ? `${+h.date.slice(4, 6)}/${+h.date.slice(6, 8)}` : `${h.hour}시`}</span>
        <span class="ic" aria-label="${esc(describe(h.sky, h.pty))}">${icon(h.sky, h.pty, h.hour)}</span>
        <span class="tt">${h.temp}°</span>
        <span class="pop${h.pop >= 60 ? ' hi' : ''}">${h.pop ? `${h.pop}%` : '&nbsp;'}</span>
      </li>`;
    })
    .join('');
  const half = (p) =>
    p
      ? `<span class="half"><span class="ic sm">${icon(p.sky, p.pty, 12)}</span><span><span class="ht">${esc(p.text)}</span><span class="pop${p.pop >= 60 ? ' hi' : ''}">${p.pop}%</span></span></span>`
      : '<span class="half muted">—</span>';
  const daily = data.daily
    .map((d) => {
      const l = dayLabel(d.date, today);
      return `<li class="d">
        <span class="dl"><b>${l.rel}</b><span class="muted">${l.md}</span></span>
        ${half(d.am)}${half(d.pm)}
        <span class="mm"><span class="lo">${d.min}°</span><span class="sep">/</span><span class="hi-t">${d.max}°</span></span>
      </li>`;
    })
    .join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.location.name)} 날씨</title>
<style>
:root{--bg:#f4f6f9;--card:#fff;--text:#16202c;--muted:#6b7684;--line:#e5e9ef;--accent:#2f6fdb;--rain:#2f6fdb;--hi:#d9480f;--lo:#2f6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--card:#18202a;--text:#e8edf3;--muted:#8d99a8;--line:#273240;--accent:#6ea2ff;--rain:#6ea2ff;--hi:#ff8a5c;--lo:#6ea2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif}
main{max-width:720px;margin:0 auto;padding:20px 16px 40px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px}
h1{font-size:20px;margin:0}
.meta{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
h2{font-size:14px;color:var(--muted);font-weight:600;margin:0 0 12px}
.now{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.now .big{font-size:56px;font-weight:300;line-height:1;letter-spacing:-2px}
.now .ic{font-size:52px;line-height:1}
.now .desc{font-size:18px;font-weight:600}
.now .range{color:var(--muted);margin-top:2px}
.stats{display:flex;gap:18px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line);flex-wrap:wrap}
.stats div{display:flex;flex-direction:column}
.stats span{color:var(--muted);font-size:12px}
.stats b{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
ul{list-style:none;margin:0;padding:0}
.hours{display:flex;overflow-x:auto;gap:2px;padding-bottom:6px;scrollbar-width:thin}
.h{flex:0 0 52px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0;border-radius:10px}
.h.newday{border-left:1px dashed var(--line)}
.hh{font-size:12px;color:var(--muted)}
.h .ic{font-size:22px;line-height:1.2}
.tt{font-weight:600;font-variant-numeric:tabular-nums}
.pop{font-size:12px;color:var(--rain);font-variant-numeric:tabular-nums}
.pop.hi{font-weight:700}
.d{display:grid;grid-template-columns:92px 1fr 1fr 78px;align-items:center;gap:8px;padding:10px 0;border-top:1px solid var(--line)}
.d:first-child{border-top:0;padding-top:0}
.dl{display:flex;flex-direction:column}
.dl .muted{font-size:12px}
.half{display:flex;align-items:center;gap:6px;font-size:13px}
.half>span:last-child{display:flex;flex-direction:column;line-height:1.25}
.ic.sm{font-size:20px}
.mm{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.lo{color:var(--lo)}.hi-t{color:var(--hi)}.sep{color:var(--muted);margin:0 3px;font-weight:400}
.muted{color:var(--muted)}
footer{color:var(--muted);font-size:12px;text-align:center;margin-top:18px}
footer a{color:inherit}
@media (max-width:480px){.d{grid-template-columns:64px 1fr 1fr 64px;gap:6px}.half{font-size:12px}.now .big{font-size:48px}}
</style>
</head>
<body>
<main>
  <header>
    <h1>${esc(data.location.name)}</h1>
    <span class="meta">업데이트 ${esc(data.updatedAt)} · 기상청 ${esc(data.issuedAt)} 발표</span>
  </header>

  <section class="card" aria-label="현재 날씨">
    <div class="now">
      <span class="ic">${icon(c.sky, c.pty, Number(data.updatedAt.slice(11, 13)))}</span>
      <span class="big">${c.temp}°</span>
      <div>
        <div class="desc">${esc(c.text)}</div>
        ${td ? `<div class="range">최저 <span class="lo">${td.min}°</span> · 최고 <span class="hi-t">${td.max}°</span></div>` : ''}
      </div>
    </div>
    <div class="stats">
      <div><span>습도</span><b>${c.reh}%</b></div>
      <div><span>바람</span><b>${c.wsd} m/s</b></div>
      ${c.rn1 ? `<div><span>1시간 강수</span><b>${esc(c.rn1)}${/mm/.test(c.rn1) ? '' : ' mm'}</b></div>` : ''}
      ${data.hourly[0] ? `<div><span>강수확률</span><b>${data.hourly[0].pop}%</b></div>` : ''}
    </div>
  </section>

  <section class="card" aria-label="시간별 예보">
    <h2>시간별 예보</h2>
    <ul class="hours">${hourly}</ul>
  </section>

  <section class="card" aria-label="일별 예보">
    <h2>일별 예보 <span class="muted" style="font-weight:400">· 오전 / 오후 / 최저·최고</span></h2>
    <ul>${daily}</ul>
  </section>

  <footer>자료: 기상청 단기예보 (공공데이터포털) · 격자 ${data.location.nx}, ${data.location.ny} · <a href="data.json">data.json</a></footer>
</main>
</body>
</html>
`;
}

// ---------- 실행 ----------
const now = kstNow();
const grid = toGrid(config.lat, config.lon);
const vBase = vilageBase(now);
console.log(`위치 ${config.name} → 격자 nx=${grid.nx}, ny=${grid.ny} / 단기예보 기준 ${vBase.base_date} ${vBase.base_time}`);

let fcst, ncst;
if (MOCK) {
  ({ fcst, ncst } = mockData(vBase, grid));
} else {
  fcst = await callApi('getVilageFcst', { ...vBase, ...grid });
  try {
    ncst = await callApi('getUltraSrtNcst', { ...ncstBase(now), ...grid });
  } catch (e) {
    console.warn(`초단기실황 실패, 예보값으로 대체: ${e.message}`);
    ncst = null;
  }
}

const data = build(fcst, ncst, now, vBase, grid);
await mkdir(OUT, { recursive: true });
await writeFile(new URL('data.json', OUT), JSON.stringify(data, null, 2) + '\n');
await writeFile(new URL('index.html', OUT), render(data, ymd(now)));
await writeFile(new URL('.nojekyll', OUT), '');
console.log(`완료: 현재 ${data.current.temp}° ${data.current.text}, 시간별 ${data.hourly.length}개, 일별 ${data.daily.length}일`);
