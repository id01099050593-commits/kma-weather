// Cloudflare Worker: 기상청 초단기실황·초단기예보 중계
// - 인증키는 Worker Secret(KMA_SERVICE_KEY)에만 보관 → 페이지에 노출되지 않음
// - 허용한 페이지 주소와 격자만 응답, 5분 캐시로 호출 수 제한
// 응답 예: { nx, ny, baseDate, baseTime, t1h, reh, wsd, vec, pty, rn1, sky }

const API = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const ALLOWED_ORIGINS = ['https://id01099050593-commits.github.io', 'http://localhost:5178'];
const ALLOWED_GRIDS = new Set(['73,133', '61,127']); // config.json 지역 격자와 맞출 것
const CACHE_SECONDS = 300;

const pad = (n) => String(n).padStart(2, '0');
const kst = (msAgo = 0) => new Date(Date.now() + 9 * 3600e3 - msAgo);
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const baseOf = (d, minute) => ({ base_date: ymd(d), base_time: `${pad(d.getUTCHours())}${minute}` });

async function call(env, op, params) {
  const raw = (env.KMA_SERVICE_KEY || '').trim();
  const key = raw.includes('%') ? decodeURIComponent(raw) : raw;
  const qs = new URLSearchParams({ serviceKey: key, pageNo: '1', numOfRows: '100', dataType: 'JSON', ...params });
  const res = await fetch(`${API}/${op}?${qs}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${op}: ${text.slice(0, 160)}`);
  }
  const h = json?.response?.header;
  if (h?.resultCode !== '00') throw new Error(`${op} ${h?.resultCode}: ${h?.resultMsg}`);
  return json.response.body.items.item;
}

async function live(env, nx, ny) {
  // 초단기실황: 정시 관측, 약 40분 뒤 제공 → 최신이 아직 없으면 한 시간 전
  let ncst, base;
  for (const lag of [40, 100]) {
    base = baseOf(kst(lag * 60e3), '00');
    try {
      ncst = await call(env, 'getUltraSrtNcst', { ...base, nx, ny });
      break;
    } catch (e) {
      if (lag === 100) throw e;
    }
  }
  const obs = Object.fromEntries(ncst.map((it) => [it.category, it.obsrValue]));

  // 하늘상태(SKY)는 실황에 없어서 초단기예보(매시 30분 발표, 약 45분 뒤 제공)의 가장 가까운 시각 값 사용
  let sky = null;
  try {
    const f = await call(env, 'getUltraSrtFcst', { ...baseOf(kst(45 * 60e3), '30'), nx, ny });
    const first = f.filter((it) => it.category === 'SKY').sort((a, b) => (a.fcstDate + a.fcstTime).localeCompare(b.fcstDate + b.fcstTime))[0];
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

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const nx = url.searchParams.get('nx');
    const ny = url.searchParams.get('ny');
    if (url.pathname !== '/now' || !ALLOWED_GRIDS.has(`${nx},${ny}`)) {
      return new Response('not found', { status: 404, headers: cors });
    }

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/now?nx=${nx}&ny=${ny}`);
    let res = await cache.match(cacheKey);
    if (!res) {
      try {
        const body = JSON.stringify(await live(env, nx, ny));
        res = new Response(body, {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
        });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
        });
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('Cache-Control', 'no-store'); // 브라우저는 매번 Worker에 확인
    return out;
  },
};
