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

// 초단기실황: 매시 정각 기준, 약 40분 뒤 제공 (hoursAgo: 어제 같은 시각 비교용)
function ncstBase(now, hoursAgo = 0) {
  const t = new Date(now.getTime() - 40 * 60e3 - hoursAgo * 3600e3);
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

// ---------- 일출·일몰 (NOAA 근사식, KST "HH:MM") ----------
function sunTimes(lat, lon, now) {
  const D = Math.PI / 180;
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const n = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start) / 86400e3) + 1;
  const g = ((2 * Math.PI) / 365) * (n - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * D) / (Math.cos(lat * D) * Math.cos(decl)) - Math.tan(lat * D) * Math.tan(decl)) / D;
  const fmt = (utcMin) => {
    const m = Math.round(utcMin + 540);
    return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
  };
  return { sunrise: fmt(720 - 4 * (lon + ha) - eqt), sunset: fmt(720 - 4 * (lon - ha) - eqt) };
}

// ---------- 체감온도 (기상청 산출식: 5~9월 여름철, 그 외 겨울철) ----------
function feelsLike(ta, rh, wsd, month) {
  if (month >= 5 && month <= 9) {
    const tw =
      ta * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(ta + rh) - Math.atan(rh - 1.67633) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
    return -0.2442 + 0.55399 * tw + 0.45535 * ta - 0.0022 * tw * tw + 0.00278 * tw * ta + 3.0;
  }
  const v = wsd * 3.6;
  if (ta > 10 || v < 4.8) return ta;
  return 13.12 + 0.6215 * ta - 11.37 * Math.pow(v, 0.16) + 0.3965 * Math.pow(v, 0.16) * ta;
}

const WIND16 = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
const windName = (vec) => (Number.isFinite(vec) ? `${WIND16[Math.floor(((vec % 360) + 11.25) / 22.5) % 16]}풍` : '바람');

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
    const rainy = i >= 20 + seed * 3 && i <= 28 + seed * 3;
    add('TMP', temp);
    add('SKY', rainy ? 4 : (i + seed) % 17 < 6 ? 3 : 1);
    add('PTY', rainy ? (i % 5 === 0 ? 4 : 1) : 0);
    add('POP', rainy ? 60 + (i % 4) * 10 : (i + seed) % 17 < 6 ? 30 : 0);
    add('PCP', rainy ? `${1 + (i % 3)}.0mm` : '강수없음');
    add('REH', 45 + (h % 7) * 7);
    add('WSD', (1.2 + (h % 5) * 0.7).toFixed(1));
    add('VEC', (i * 37) % 360);
    if (h === 6) add('TMN', temp);
    if (h === 15) add('TMX', temp);
  }
  return fcst;
}
const mockNcst = (seed, offset = 0) =>
  [['T1H', 15.3 + seed - offset], ['RN1', 0], ['REH', 62], ['WSD', 1.8], ['PTY', 0], ['VEC', 315]].map(([category, obsrValue]) => ({ category, obsrValue: String(obsrValue) }));

// ---------- 데이터 가공 ----------
const PTY = { 1: '비', 2: '비/눈', 3: '눈', 4: '소나기', 5: '빗방울', 6: '빗방울/눈날림', 7: '눈날림' };
const SKY = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const describe = (sky, pty) => (pty && pty !== '0' ? PTY[pty] ?? '강수' : SKY[sky] ?? '-');

const mode = (arr) => {
  const c = {};
  for (const v of arr) c[v] = (c[v] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
};
const round1 = (n) => Math.round(n * 10) / 10;

// 최신 발표를 우선하고, 빠진 시각(오늘 지난 시간·오늘 최저기온 등)은 이른 발표로 채움
function mergeFcst(latest, earlier) {
  const key = (it) => it.category + it.fcstDate + it.fcstTime;
  const seen = new Set(latest.map(key));
  return [...latest, ...earlier.filter((it) => !seen.has(key(it)))];
}

function build(loc, grid, fcstItems, ncstItems, yestTemp, now, base) {
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
    sno: s.SNO && s.SNO !== '적설없음' ? s.SNO : null,
    reh: Number(s.REH ?? 0),
    wsd: Number(s.WSD ?? 0),
    vec: s.VEC !== undefined ? Number(s.VEC) : null,
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
  const temp = Number(ncst.T1H ?? cur.TMP);
  const reh = Number(ncst.REH ?? cur.REH);
  const wsd = Number(ncst.WSD ?? cur.WSD);
  const vec = Number(ncst.VEC ?? cur.VEC);
  return {
    id: loc.id,
    name: loc.name,
    detail: loc.detail,
    lat: loc.lat,
    lon: loc.lon,
    ...grid,
    issuedAt: `${base.base_date.slice(4, 6)}/${base.base_date.slice(6, 8)} ${base.base_time.slice(0, 2)}:00`,
    current: {
      temp,
      sky: cur.SKY,
      pty,
      text: describe(cur.SKY, pty),
      reh,
      wsd,
      vec: Number.isFinite(vec) ? vec : null,
      wind: windName(vec),
      feels: round1(feelsLike(temp, reh, wsd, now.getUTCMonth() + 1)),
      vsYesterday: Number.isFinite(yestTemp) ? round1(temp - yestTemp) : null,
      pop: Number(cur.POP ?? 0),
      rn1: ncst.RN1 && ncst.RN1 !== '0' && ncst.RN1 !== '강수없음' ? ncst.RN1 : null,
      observed: Boolean(ncstItems),
      ...sunTimes(loc.lat, loc.lon, now),
    },
    hourly,
    daily,
  };
}

// 관측 기온 기록 키 ("YYYYMMDDHH"). 실황 API는 최근 24시간 이내만 주므로
// 매 실행마다 지난 23시간을 기록해 두고, 다음 날 같은 시각과 비교한다.
const histKey = (b) => b.base_date + b.base_time.slice(0, 2);

async function fetchLocation(loc, now, index, hist) {
  // config.json에 nx, ny를 적으면 그 격자를 그대로 사용 (기상청 격자 엑셀 값으로 고정할 때)
  const grid = loc.nx && loc.ny ? { nx: loc.nx, ny: loc.ny } : toGrid(loc.lat, loc.lon);
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
    hist[histKey(ncstBase(now, 24))] ??= 15.3 + index * 2 - 1.4;
  } else {
    latest = await callApi('getVilageFcst', { ...vBase, ...grid });
    const optional = async (label, fn) => {
      try {
        return await fn();
      } catch (e) {
        console.warn(`${loc.name} ${label} 실패, 생략: ${e.message}`);
        return null;
      }
    };
    if (needEarly) early = (await optional('02시 발표 보조자료', () => callApi('getVilageFcst', { ...earlyBase, ...grid }))) ?? [];
    ncst = await optional('초단기실황', () => callApi('getUltraSrtNcst', { ...ncstBase(now), ...grid }));
    const t1h = (items) => {
      const v = Number(items?.find((it) => it.category === 'T1H')?.obsrValue);
      return Number.isFinite(v) ? v : null;
    };
    if (t1h(ncst) !== null) hist[histKey(ncstBase(now))] = t1h(ncst);
    let filled = 0;
    for (let h = 1; h <= 23; h++) {
      const b = ncstBase(now, h);
      if (hist[histKey(b)] !== undefined) continue;
      const v = t1h(await optional(`${h}시간 전 실황`, () => callApi('getUltraSrtNcst', { ...b, ...grid })));
      if (v !== null) {
        hist[histKey(b)] = v;
        filled++;
      }
    }
    if (filled) console.log(`${loc.name} 관측 기록 ${filled}시간 추가`);
  }
  const yestTemp = hist[histKey(ncstBase(now, 24))];
  return build(loc, grid, mergeFcst(latest, early), ncst, yestTemp ?? null, now, vBase);
}

// ---------- 아이콘 (SVG 심볼, 64x64) ----------
const ICON_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="s-sun" viewBox="0 0 64 64"><g stroke="#ffb31a" stroke-width="4" stroke-linecap="round"><path d="M32 5v7M32 52v7M5 32h7M52 32h7M12.9 12.9l5 5M46.1 46.1l5 5M12.9 51.1l5-5M46.1 17.9l5-5"/></g><circle cx="32" cy="32" r="13" fill="#ffc21f"/></symbol>
<symbol id="s-moon" viewBox="0 0 64 64"><path d="M38 10a22 22 0 1 0 16 33A18 18 0 0 1 38 10z" fill="#ffcf3d"/></symbol>
<symbol id="s-cloud" viewBox="0 0 64 64"><path d="M18 52h30a10 10 0 0 0 1-20 15 15 0 0 0-28-4 12 12 0 0 0-3 24z"/></symbol>
<symbol id="s-drops" viewBox="0 0 64 64"><g stroke="#3d8bfd" stroke-width="4" stroke-linecap="round"><path d="M22 50l-3 8M33 50l-3 8M44 50l-3 8"/></g></symbol>
<symbol id="s-flakes" viewBox="0 0 64 64"><g fill="#7cb6f2"><circle cx="21" cy="54" r="3.2"/><circle cx="32" cy="58" r="3.2"/><circle cx="43" cy="54" r="3.2"/></g></symbol>
<symbol id="s-mix" viewBox="0 0 64 64"><path d="M24 50l-3 8M44 50l-3 8" stroke="#3d8bfd" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="56" r="3.2" fill="#7cb6f2"/></symbol>
</defs></svg>`;

// 밤낮 판단: 렌더 중인 지역의 일출·일몰(분). hour는 소수 가능(현재 시각), 정시 예보칸은 칸 중간(:30) 기준
let SUN = { rise: 6 * 60, set: 19 * 60 };
const toMin = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
function iconInner(sky, pty, hour) {
  const m = hour === undefined ? 12 * 60 : Number.isInteger(hour) ? hour * 60 + 30 : hour * 60;
  const night = m < SUN.rise || m >= SUN.set;
  const body = night ? 's-moon' : 's-sun';
  const wet = pty && pty !== '0';
  if (wet) {
    const fall = { 3: 's-flakes', 7: 's-flakes', 2: 's-mix', 6: 's-mix' }[pty] ?? 's-drops';
    const sunny = pty === '4' ? `<use href="#${body}" x="22" y="-4" width="40" height="40"/>` : '';
    return `${sunny}<use href="#s-cloud" y="-8" fill="#aebccb"/><use href="#${fall}"/>`;
  }
  if (sky === '1') return `<use href="#${body}"/>`;
  if (sky === '3') return `<use href="#${body}" x="-4" y="-6" width="46" height="46"/><use href="#s-cloud" x="6" y="4" width="58" height="58" fill="#d7dee7"/>`;
  return `<use href="#s-cloud" x="-6" y="-6" width="52" height="52" fill="#c3ccd7"/><use href="#s-cloud" x="4" y="2" width="60" height="60" fill="#a9b5c3"/>`;
}
const iconSvg = (sky, pty, hour, cls, label) =>
  `<svg class="${cls}" viewBox="0 0 64 64" role="img" aria-label="${esc(label ?? describe(sky, pty))}">${iconInner(sky, pty, hour)}</svg>`;

// ---------- HTML ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function dayInfo(date, today) {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
  const t = new Date(Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8)));
  const diff = Math.round((d - t) / 86400e3);
  const dow = d.getUTCDay();
  return {
    rel: ['오늘', '내일', '모레'][diff] ?? `${DOW[dow]}요일`,
    dow: DOW[dow],
    md: `${+date.slice(4, 6)}.${+date.slice(6, 8)}.`,
    cls: dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
  };
}

// 시간별 예보: 날씨 / 강수 / 바람 / 습도 네 가지 그래프 (같은 폭이라 스크롤 위치 공유)
const COL = 58;
function hourlyCharts(loc, today) {
  const hs = loc.hourly;
  const n = hs.length;
  const W = n * COL;
  const cx = (i) => i * COL + COL / 2;
  const label = (h, i) => {
    if (i === 0) return '지금';
    if (h.hour === 0) return dayInfo(h.date, today).rel;
    return `${h.hour}시`;
  };
  const timeRow = (y) =>
    hs.map((h, i) => `<text x="${cx(i)}" y="${y}" class="${i === 0 || h.hour === 0 ? 'tb' : 't'}">${label(h, i)}</text>`).join('');
  const dayLines = (y1, y2) =>
    hs.map((h, i) => (i > 0 && h.hour === 0 ? `<line x1="${i * COL}" x2="${i * COL}" y1="${y1}" y2="${y2}" class="dl"/>` : '')).join('');

  // 날씨: 아이콘 + 기온 꺾은선
  const temps = hs.map((h, i) => (i === 0 ? Math.round(loc.current.temp) : h.temp));
  const tMin = Math.min(...temps), tMax = Math.max(...temps);
  const ty = (t) => (tMax === tMin ? 108 : 124 - ((t - tMin) / (tMax - tMin)) * 36);
  const pts = temps.map((t, i) => `${cx(i)},${ty(t).toFixed(1)}`).join(' ');
  const weather = `<svg class="chart" data-v="w" width="${W}" height="168" viewBox="0 0 ${W} 168">
    ${dayLines(6, 160)}
    ${hs.map((h, i) => `<svg x="${cx(i) - 17}" y="18" width="34" height="34" viewBox="0 0 64 64">${iconInner(h.sky, h.pty, h.hour)}</svg>`).join('')}
    <polyline points="${pts}" class="ln"/>
    ${temps.map((t, i) => `<circle cx="${cx(i)}" cy="${ty(t).toFixed(1)}" r="3.5" class="${i === 0 ? 'dot now' : 'dot'}"/><text x="${cx(i)}" y="${(ty(t) - 11).toFixed(1)}" class="tv"${i === 0 ? ' data-k="now"' : ''}>${t}°</text>`).join('')}
    ${timeRow(156)}
  </svg>`;

  // 강수: 강수확률 막대 + 강수량
  const rain = `<svg class="chart" data-v="r" width="${W}" height="168" viewBox="0 0 ${W} 168" hidden>
    ${dayLines(6, 160)}
    ${hs.map((h, i) => {
      const bh = Math.max(2, (h.pop / 100) * 80);
      return `<rect x="${cx(i) - 9}" y="${116 - bh}" width="18" height="${bh}" rx="4" class="${h.pop >= 60 ? 'bar hi' : 'bar'}"/>
        <text x="${cx(i)}" y="${116 - bh - 8}" class="pv${h.pop >= 60 ? ' b' : ''}">${h.pop}%</text>
        <text x="${cx(i)}" y="134" class="sm">${esc(h.sno ?? (h.pcp ? h.pcp.replace('mm', '') : '-'))}</text>`;
    }).join('')}
    ${timeRow(156)}
  </svg>`;

  // 바람: 방향 화살표 + 풍속
  const wind = `<svg class="chart" data-v="d" width="${W}" height="168" viewBox="0 0 ${W} 168" hidden>
    ${dayLines(6, 160)}
    ${hs.map((h, i) => `${h.vec !== null ? `<g transform="translate(${cx(i)} 46) rotate(${(h.vec + 180) % 360})"><path d="M0-13L7 7 0 2-7 7z" class="arw${h.wsd >= 9 ? ' hi' : ''}"/></g>` : ''}
        <text x="${cx(i)}" y="92" class="wv">${h.wsd}</text>
        <text x="${cx(i)}" y="108" class="sm">m/s</text>
        <text x="${cx(i)}" y="130" class="sm">${h.vec !== null ? windName(h.vec).replace('풍', '') : ''}</text>`).join('')}
    ${timeRow(156)}
  </svg>`;

  // 습도: 막대
  const hum = `<svg class="chart" data-v="h" width="${W}" height="168" viewBox="0 0 ${W} 168" hidden>
    ${dayLines(6, 160)}
    ${hs.map((h, i) => {
      const bh = Math.max(2, (h.reh / 100) * 90);
      return `<rect x="${cx(i) - 9}" y="${130 - bh}" width="18" height="${bh}" rx="4" class="bar hm"/>
        <text x="${cx(i)}" y="${130 - bh - 8}" class="pv hm">${h.reh}%</text>`;
    }).join('')}
    ${timeRow(156)}
  </svg>`;

  return weather + rain + wind + hum;
}

function renderPanel(loc, today, nowHour) {
  const c = loc.current;
  SUN = { rise: toMin(c.sunrise), set: toMin(c.sunset) };
  const td = loc.daily[0];
  const vs =
    c.vsYesterday === null
      ? ''
      : c.vsYesterday === 0
        ? '<span class="vs">어제와 같아요</span>'
        : `<span class="vs">어제보다 <b class="${c.vsYesterday > 0 ? 'up' : 'down'}">${Math.abs(c.vsYesterday)}°</b> ${c.vsYesterday > 0 ? '높아요' : '낮아요'}</span>`;

  const half = (p) =>
    p
      ? `<span class="half"><span class="pp${p.pop >= 60 ? ' b' : ''}">${p.pop}%</span>${iconSvg(p.sky, p.pty, 12, 'di', p.text)}</span>`
      : '<span class="half"><span class="pp"></span><span class="di none">-</span></span>';
  const daily = loc.daily
    .map((d, i) => {
      const l = dayInfo(d.date, today);
      return `<li class="d${i === 0 ? ' today' : ''}">
          <span class="dd"><b class="${l.cls}">${l.dow}</b><small>${l.md}</small></span>
          ${half(d.am)}${half(d.pm)}
          <span class="mm"><span class="lo">${d.min}°</span><span class="sl">/</span><span class="hi">${d.max}°</span></span>
        </li>`;
    })
    .join('');

  return `<section class="panel" id="p-${esc(loc.id)}" aria-label="${esc(loc.name)} 날씨" data-nx="${loc.nx}" data-ny="${loc.ny}" data-rise="${c.sunrise}" data-set="${c.sunset}" data-sky="${esc(c.sky ?? '')}">
    <div class="card now">
      <p class="loc">${esc(loc.detail)}</p>
      <div class="hero">
        ${iconSvg(c.sky, c.pty, nowHour, 'big', c.text).replace('<svg ', '<svg data-k="icon" ')}
        <div class="tempbox">
          <span class="lab" data-k="lab">현재 온도</span>
          <p class="temp"><b data-k="temp">${c.temp}</b><span>°</span></p>
        </div>
      </div>
      <p class="sum"><b data-k="text">${esc(c.text)}</b><span data-k="vs">${vs}</span></p>
      <dl class="info">
        <div><dt>체감</dt><dd data-k="feels">${c.feels}°</dd></div>
        <div><dt>습도</dt><dd data-k="reh">${c.reh}%</dd></div>
        <div><dt data-k="wind">${esc(c.wind)}</dt><dd data-k="wsd">${c.wsd}m/s</dd></div>
      </dl>
      <ul class="chips">
        <li><span>강수확률</span><b class="${c.pop >= 60 ? 'blue' : ''}">${c.pop}%</b></li>
        ${c.rn1 ? `<li><span>1시간 강수</span><b class="blue">${esc(String(c.rn1).replace(/\s*mm$/, ''))}mm</b></li>` : td ? `<li><span>최저/최고</span><b><span class="lo">${td.min}°</span>/<span class="hi">${td.max}°</span></b></li>` : ''}
        <li><span>일출</span><b>${c.sunrise}</b></li>
        <li><span>일몰</span><b>${c.sunset}</b></li>
      </ul>
    </div>

    <div class="card">
      <div class="head">
        <h2>시간별 예보</h2>
        <div class="seg" role="tablist" aria-label="시간별 예보 항목">
          <button type="button" data-v="w" aria-selected="true">날씨</button>
          <button type="button" data-v="r" aria-selected="false">강수</button>
          <button type="button" data-v="d" aria-selected="false">바람</button>
          <button type="button" data-v="h" aria-selected="false">습도</button>
        </div>
      </div>
      <div class="scroll">${hourlyCharts(loc, today)}</div>
    </div>

    <div class="card">
      <div class="head">
        <h2>일별 예보</h2>
        <span class="cap">오전 · 오후 강수확률</span>
      </div>
      <ul class="days">${daily}</ul>
    </div>

    <p class="src">기상청 ${esc(loc.issuedAt)} 발표 · 격자 ${loc.nx}, ${loc.ny}</p>
  </section>`;
}

function render(data, today, nowHour) {
  const tabs = data.locations
    .map((l, i) => `<button role="tab" type="button" aria-selected="${i === 0}" aria-controls="p-${esc(l.id)}">${esc(l.name)}</button>`)
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
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
:root{--bg:#f2f4f7;--card:#fff;--text:#1e1e23;--sub:#505660;--muted:#8a919c;--faint:#b5bbc4;--line:#eef0f3;--green:#03c75a;--blue:#3d7bf7;--red:#f2484a;--chip:#f5f7f9}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
ul,dl,dd{list-style:none;margin:0;padding:0}
p,h2{margin:0}
button{font:inherit;cursor:pointer}
.top{position:sticky;top:0;z-index:5;background:#fff;padding-top:env(safe-area-inset-top);box-shadow:0 1px 0 var(--line)}
.top-in{display:flex;align-items:center;justify-content:space-between;max-width:560px;margin:0 auto;padding:0 18px}
.brand{font-size:18px;font-weight:800;letter-spacing:-.04em}
.brand i{font-style:normal;color:var(--green)}
.tabs{display:flex;gap:4px}
.tabs button{border:0;background:none;font-size:16px;font-weight:600;color:var(--muted);padding:15px 10px 13px;border-bottom:3px solid transparent;transition:color .2s,border-color .2s}
.tabs button[aria-selected="true"]{color:var(--text);font-weight:800;border-bottom-color:var(--green)}
.pager{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;align-items:flex-start;overscroll-behavior-x:contain}
.pager::-webkit-scrollbar{display:none}
.panel{flex:0 0 100%;width:100%;scroll-snap-align:start;scroll-snap-stop:always;padding:12px 12px calc(env(safe-area-inset-bottom) + 16px)}
.panel>*{max-width:560px;margin-left:auto;margin-right:auto}
.card{background:var(--card);border-radius:20px;padding:20px 18px;margin-bottom:10px}
.now{padding-top:16px}
.loc{font-size:13px;color:var(--muted);text-align:center}
.hero{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:8px}
.big{width:96px;height:96px;flex:none}
.tempbox{display:flex;flex-direction:column}
.lab{font-size:13px;color:var(--muted);margin-bottom:-4px}
.temp{font-size:58px;font-weight:700;letter-spacing:-.05em;line-height:1.1;font-variant-numeric:tabular-nums}
.temp b{font-weight:inherit}
.temp span{font-weight:400;color:var(--sub);margin-left:2px}
.sum{display:flex;justify-content:center;align-items:baseline;gap:8px;margin-top:10px;font-size:16px}
.sum b{font-weight:800}
.vs{color:var(--sub);font-size:15px}
.vs b{font-weight:700}
.up{color:var(--red)}.down{color:var(--blue)}
.info{display:flex;justify-content:center;gap:16px;margin-top:8px;font-size:14px}
.info div{display:flex;gap:5px}
.info dt{color:var(--muted)}
.info dd{font-weight:600;font-variant-numeric:tabular-nums}
.chips{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:18px}
.chips li{background:var(--chip);border-radius:14px;padding:10px 2px;display:flex;flex-direction:column;align-items:center;gap:2px}
.chips span{font-size:12px;color:var(--muted)}
.chips b{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.blue{color:var(--blue)}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
h2{font-size:17px;font-weight:800}
.cap{font-size:12px;color:var(--muted)}
.seg{display:flex;background:var(--chip);border-radius:10px;padding:3px}
.seg button{border:0;background:none;font-size:13px;font-weight:600;color:var(--muted);padding:5px 9px;border-radius:8px}
.seg button[aria-selected="true"]{background:#fff;color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.scroll{overflow-x:auto;scrollbar-width:none;margin:0 -18px;padding:0 6px;overscroll-behavior-x:contain}
.scroll::-webkit-scrollbar{display:none}
.chart{display:block}
.chart[hidden]{display:none}
.chart text{text-anchor:middle;font-family:inherit;letter-spacing:-.01em}
.chart .t{font-size:12px;fill:var(--muted)}
.chart .tb{font-size:12px;font-weight:700;fill:var(--text)}
.chart .tv{font-size:14px;font-weight:700;fill:var(--text)}
.chart .ln{fill:none;stroke:#ffb31a;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .dot{fill:#fff;stroke:#ffb31a;stroke-width:2}
.chart .dot.now{fill:#ffb31a}
.chart .dl{stroke:var(--line);stroke-width:1}
.chart .bar{fill:#cfe0fd}
.chart .bar.hi{fill:var(--blue)}
.chart .bar.hm{fill:#c9efd9}
.chart .pv{font-size:12px;font-weight:600;fill:var(--blue)}
.chart .pv.b{font-weight:800}
.chart .pv.hm{fill:#12a150}
.chart .sm{font-size:11px;fill:var(--muted)}
.chart .wv{font-size:14px;font-weight:700;fill:var(--text)}
.chart .arw{fill:#7d8896}
.chart .arw.hi{fill:var(--red)}
.days .d{display:grid;grid-template-columns:1fr 74px 74px 82px;align-items:center;padding:11px 6px;border-top:1px solid var(--line)}
.days .d:first-child{border-top:0}
.days .today{background:#f7fbf9;border-radius:12px;border-top-color:transparent}
.days .today+.d{border-top-color:transparent}
.dd{display:flex;align-items:baseline;gap:6px}
.dd b{font-size:15px;font-weight:700}
.dd b.sat{color:var(--blue)}.dd b.sun{color:var(--red)}
.dd small{font-size:12px;color:var(--muted)}
.half{display:flex;align-items:center;justify-content:flex-end;gap:4px}
.pp{font-size:12px;color:var(--blue);font-weight:600;font-variant-numeric:tabular-nums;min-width:28px;text-align:right}
.pp.b{font-weight:800}
.di{width:32px;height:32px;flex:none}
.di.none{display:inline-flex;align-items:center;justify-content:center;color:var(--faint)}
.mm{text-align:right;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.lo{color:var(--blue)}.hi{color:var(--red)}
.sl{color:var(--faint);margin:0 3px;font-weight:400}
.src{font-size:11px;color:var(--faint);text-align:center;margin-top:12px}
.ptr{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 58px);width:38px;height:38px;margin-left:-19px;border-radius:50%;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.14);display:flex;align-items:center;justify-content:center;z-index:4;opacity:0;transform:translateY(-60px);pointer-events:none}
.ptr svg{width:20px;height:20px}
.ptr.spin svg{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
footer{text-align:center;font-size:12px;color:var(--muted);padding:0 16px calc(env(safe-area-inset-bottom) + 20px)}
@media (max-width:360px){.days .d{grid-template-columns:1fr 64px 64px 72px}.chips b{font-size:13px}.info{gap:10px}}
</style>
</head>
<body>
${ICON_DEFS}
<header class="top"><div class="top-in">
  <span class="brand">날씨<i>.</i></span>
  <nav class="tabs" role="tablist" aria-label="지역">${tabs}</nav>
</div></header>
<main class="pager" id="pager">
${data.locations.map((l) => renderPanel(l, today, nowHour)).join('\n')}
</main>
<div class="ptr" id="ptr" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#03c75a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg></div>
<footer>${esc(data.updatedAt)} 업데이트 · 자료 기상청</footer>
<script>
(() => {
  const pager = document.getElementById('pager');
  const tabs = [...document.querySelectorAll('[role=tab][aria-controls]')];
  const ids = tabs.map((t) => t.getAttribute('aria-controls').slice(2));
  let cur = -1;
  const mark = (i) => {
    if (i === cur) return;
    cur = i;
    tabs.forEach((t, j) => t.setAttribute('aria-selected', String(j === i)));
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

  // 당겨서 새로고침: 홈 화면 앱 모드용 (Safari 탭에는 기본 기능이 있음). 테스트: 주소 끝에 ?ptr=1
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches || /[?&]ptr=1/.test(location.search);
  const ptr = document.getElementById('ptr');
  if (standalone && ptr) {
    const TH = 70;
    let y0 = null, x0 = 0, dy = 0, pulling = false;
    const set = (d, anim) => {
      ptr.style.transition = anim ? 'transform .25s, opacity .25s' : 'none';
      ptr.style.opacity = String(Math.min(1, d / TH));
      ptr.style.transform = 'translateY(' + (Math.min(d, TH * 1.4) - 60) + 'px) rotate(' + d * 3 + 'deg)';
    };
    addEventListener('touchstart', (e) => {
      y0 = window.scrollY > 0 || e.touches.length !== 1 ? null : e.touches[0].clientY;
      if (y0 !== null) { x0 = e.touches[0].clientX; dy = 0; pulling = false; }
    }, { passive: true });
    addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      const ddy = e.touches[0].clientY - y0, ddx = e.touches[0].clientX - x0;
      if (!pulling) {
        // 좌우 스와이프(지역 전환)나 위로 스크롤이면 무시
        if (Math.abs(ddx) > Math.abs(ddy) || ddy < 0) { if (Math.abs(ddx) > 8 || ddy < -8) y0 = null; return; }
        if (ddy < 8) return;
        pulling = true;
      }
      dy = ddy * 0.5;
      e.preventDefault();
      set(dy, false);
    }, { passive: false });
    addEventListener('touchend', () => {
      if (!pulling) { y0 = null; return; }
      y0 = null;
      pulling = false;
      if (dy >= TH) {
        ptr.classList.add('spin');
        set(TH, true);
        setTimeout(() => location.replace(location.pathname + '?v=' + Date.now() + location.hash), 300);
      } else set(0, true);
    });
  }

  // 현재 날씨 실시간 갱신: 페이지를 열 때마다 중계 서버(Cloudflare Worker)에서 기상청 최신 실황을 받아 교체
  const LIVE = ${JSON.stringify(data.liveApi || '')};
  const PTY = ${JSON.stringify(PTY)}, SKY = ${JSON.stringify(SKY)}, WIND16 = ${JSON.stringify(WIND16)};
  let SUN = { rise: 360, set: 1140 };
  const toMin = ${toMin.toString()};
  const describe = ${describe.toString()};
  const windName = ${windName.toString()};
  ${feelsLike.toString()}
  ${iconInner.toString()}
  const p2 = (n) => String(n).padStart(2, '0');
  let HIST = null;
  const liveUpdate = async () => {
    if (!LIVE) return;
    if (!HIST) {
      try { HIST = await (await fetch('history.json?t=' + Date.now(), { cache: 'no-store' })).json(); } catch (e) { HIST = {}; }
    }
    document.querySelectorAll('.panel[data-nx]').forEach(async (p) => {
      try {
        const r = await fetch(LIVE + '/now?nx=' + p.dataset.nx + '&ny=' + p.dataset.ny, { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (d.t1h === null || d.t1h === undefined) return;
        const q = (k) => p.querySelector('[data-k="' + k + '"]');
        const k = new Date(Date.now() + 9 * 3600e3);
        // 실황은 정시 관측이 약 40분 뒤 공개됨 → 관측 후 50분이 넘었으면
        // 현재 시각에 가장 가까운 정시의 초단기예보 값을 사용 (해 질 녘처럼 기온이 빨리 변할 때 차이를 줄임)
        let cd = d.baseDate, hh = +d.baseTime.slice(0, 2), kind = '관측';
        const obsAt = Date.UTC(+cd.slice(0, 4), +cd.slice(4, 6) - 1, +cd.slice(6, 8), hh);
        if (k.getTime() - obsAt > 50 * 60e3 && d.fcst) {
          const n = new Date(k.getTime() + 30 * 60e3);
          const key = n.getUTCFullYear() + p2(n.getUTCMonth() + 1) + p2(n.getUTCDate()) + p2(n.getUTCHours()) + '00';
          const f = d.fcst.find((x) => x.date + x.time === key);
          if (f && f.t1h !== null) {
            d.t1h = f.t1h;
            if (f.reh !== null) d.reh = f.reh;
            if (f.wsd !== null) { d.wsd = f.wsd; d.vec = f.vec; }
            if (f.pty !== null) d.pty = f.pty;
            if (f.sky !== null) d.sky = f.sky;
            cd = f.date; hh = +f.time.slice(0, 2); kind = '예보';
          }
        }
        const sky = d.sky || p.dataset.sky, pty = d.pty ?? '0';
        SUN = { rise: toMin(p.dataset.rise), set: toMin(p.dataset.set) };
        q('icon').innerHTML = iconInner(sky, pty, k.getUTCHours() + k.getUTCMinutes() / 60 + 1e-6);
        q('temp').textContent = d.t1h;
        q('text').textContent = describe(sky, pty);
        q('lab').textContent = '현재 온도 · ' + hh + '시 ' + kind;
        if (d.reh !== null) q('reh').textContent = d.reh + '%';
        if (d.wsd !== null) { q('wsd').textContent = d.wsd + 'm/s'; q('wind').textContent = windName(d.vec); }
        q('feels').textContent = Math.round(feelsLike(d.t1h, d.reh ?? 50, d.wsd ?? 0, +d.baseDate.slice(4, 6)) * 10) / 10 + '°';
        if (q('now')) q('now').textContent = Math.round(d.t1h) + '°';
        // 어제 같은 시각 관측값(history.json)과 비교
        const y = new Date(Date.UTC(+cd.slice(0, 4), +cd.slice(4, 6) - 1, +cd.slice(6, 8), hh) - 86400e3);
        const prev = HIST?.[p.id.slice(2)]?.[y.getUTCFullYear() + p2(y.getUTCMonth() + 1) + p2(y.getUTCDate()) + p2(y.getUTCHours())];
        if (prev !== undefined) {
          const diff = Math.round((d.t1h - prev) * 10) / 10;
          q('vs').innerHTML = diff === 0 ? '<span class="vs">어제와 같아요</span>'
            : '<span class="vs">어제보다 <b class="' + (diff > 0 ? 'up' : 'down') + '">' + Math.abs(diff) + '°</b> ' + (diff > 0 ? '높아요' : '낮아요') + '</span>';
        }
      } catch (e) {}
    });
  };
  liveUpdate();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) liveUpdate(); });

  // 캐시된 옛 화면이면 최신 버전으로 자동 새로고침 (앱을 다시 열 때도 확인)
  const BUILT = ${JSON.stringify(data.updatedAt)};
  const check = async () => {
    try {
      const d = await (await fetch('data.json?t=' + Date.now(), { cache: 'no-store' })).json();
      if (d.updatedAt === BUILT) { sessionStorage.removeItem('reloads'); return; }
      const n = Number(sessionStorage.getItem('reloads') || 0);
      if (n >= 2) return;
      sessionStorage.setItem('reloads', String(n + 1));
      location.replace(location.pathname + '?v=' + Date.now() + location.hash);
    } catch (e) {}
  };
  check();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });

  // 시간별 예보 항목 전환 (날씨/강수/바람/습도)
  document.querySelectorAll('.seg').forEach((seg) => {
    const card = seg.closest('.card');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      card.querySelectorAll('.chart').forEach((c) => c.toggleAttribute('hidden', c.dataset.v !== b.dataset.v));
    });
  });
})();
</script>
</body>
</html>
`;
}

// ---------- 실행 ----------
const now = kstNow();
const locations = [];
const HISTORY = new URL('history.json', OUT);
let history = {};
try {
  history = JSON.parse(await readFile(HISTORY, 'utf8'));
} catch {}
const oldest = histKey(ncstBase(now, 72)); // 3일 지난 기록은 삭제
for (const [i, loc] of config.locations.entries()) {
  const hist = Object.fromEntries(Object.entries(history[loc.id] ?? {}).filter(([k]) => k >= oldest));
  locations.push(await fetchLocation(loc, now, i, hist));
  history[loc.id] = Object.fromEntries(Object.entries(hist).sort());
}

const data = {
  title: config.title,
  liveApi: config.liveApi || '',
  updatedAt: `${+(now.getUTCMonth() + 1)}월 ${now.getUTCDate()}일 ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`,
  locations,
};
await mkdir(OUT, { recursive: true });
await writeFile(new URL('data.json', OUT), JSON.stringify(data, null, 2) + '\n');
await writeFile(new URL('index.html', OUT), render(data, ymd(now), now.getUTCHours() + now.getUTCMinutes() / 60 + 1e-6));
await writeFile(new URL('.nojekyll', OUT), '');
if (!MOCK) await writeFile(HISTORY, JSON.stringify(history, null, 1) + '\n');
for (const l of locations) {
  const c = l.current;
  console.log(`완료 ${l.name}: ${c.temp}° ${c.text}, 체감 ${c.feels}°, 어제대비 ${c.vsYesterday ?? '-'}, 일출 ${c.sunrise} 일몰 ${c.sunset}, 시간별 ${l.hourly.length}개, 날짜별 ${l.daily.length}일`);
}
