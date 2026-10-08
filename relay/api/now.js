// Vercel 함수: 기상청 초단기실황·초단기예보 중계  (주소: /api/now?nx=73&ny=133)
// - 인증키는 Vercel 환경변수(KMA_SERVICE_KEY)에만 보관 → 페이지에 노출되지 않음
// - 허용한 격자만 응답, Vercel CDN에서 5분 캐시해 기상청 호출 수 제한
// 응답 예: { nx, ny, baseDate, baseTime, t1h, reh, wsd, vec, pty, rn1, sky }

const API = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const ALLOWED_ORIGIN = 'https://id01099050593-commits.github.io';
const ALLOWED_GRIDS = new Set(['73,133', '61,127']); // config.json 지역 격자와 맞출 것

const pad = (n) => String(n).padStart(2, '0');
const kst = (msAgo = 0) => new Date(Date.now() + 9 * 3600e3 - msAgo);
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const baseOf = (d, minute) => ({ base_date: ymd(d), base_time: `${pad(d.getUTCHours())}${minute}` });

async function call(op, params) {
  const raw = (process.env.KMA_SERVICE_KEY || '').trim();
  if (!raw) throw new Error('KMA_SERVICE_KEY 환경변수가 없습니다');
  const key = raw.includes('%') ? decodeURIComponent(raw) : raw;
  const qs = new URLSearchParams({ serviceKey: key, pageNo: '1', numOfRows: '100', dataType: 'JSON', ...params });
  const res = await fetch(`${API}/${op}?${qs}`, { signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${op}: ${text.slice(0, 160)}`);
  }
  const h = json?.response?.header;
  if (!h) throw new Error(`${op} (HTTP ${res.status}): ${text.slice(0, 200)}`);
  if (h.resultCode !== '00') throw new Error(`${op} ${h.resultCode}: ${h.resultMsg}`);
  return json.response.body.items.item;
}

async function live(nx, ny) {
  // 초단기실황: 정시 관측, 약 40분 뒤 제공 → 최신이 아직 없으면 한 시간 전
  let ncst, base;
  for (const lag of [40, 100]) {
    base = baseOf(kst(lag * 60e3), '00');
    try {
      ncst = await call('getUltraSrtNcst', { ...base, nx, ny });
      break;
    } catch (e) {
      if (lag === 100) throw e;
    }
  }
  const obs = Object.fromEntries(ncst.map((it) => [it.category, it.obsrValue]));

  // 하늘상태(SKY)는 실황에 없어서 초단기예보(매시 30분 발표, 약 45분 뒤 제공)의 가장 가까운 시각 값 사용
  let sky = null;
  try {
    const f = await call('getUltraSrtFcst', { ...baseOf(kst(45 * 60e3), '30'), nx, ny });
    const first = f
      .filter((it) => it.category === 'SKY')
      .sort((a, b) => (a.fcstDate + a.fcstTime).localeCompare(b.fcstDate + b.fcstTime))[0];
    sky = first?.fcstValue ?? null;
  } catch {}

  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    nx: Number(nx),
    ny: Number(ny),
    baseDate: base.base_date,
    baseTime: base.base_time,
    t1h: num(obs.T1H),
    reh: num(obs.REH),
    wsd: num(obs.WSD),
    vec: num(obs.VEC),
    pty: obs.PTY ?? null,
    rn1: obs.RN1 ?? null,
    sky,
  };
}

const CORS = { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra } });

export function OPTIONS() {
  return new Response(null, { headers: CORS });
}

export async function GET(request) {
  const url = new URL(request.url);
  const nx = url.searchParams.get('nx');
  const ny = url.searchParams.get('ny');
  if (!ALLOWED_GRIDS.has(`${nx},${ny}`)) return json({ error: 'not allowed' }, 404);
  try {
    // CDN 5분 캐시 (브라우저는 캐시하지 않음)
    return json(await live(nx, ny), 200, { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'max-age=300' });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502, { 'Cache-Control': 'no-store' });
  }
}
