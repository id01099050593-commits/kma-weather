// Vercel 함수: 공공데이터포털 API 제한 중계  (주소: /api/proxy?svc=vilage&op=getVilageFcst&nx=73&ny=133&...)
// GitHub Actions(해외)에서 apis.data.go.kr 접속이 막힐 때를 대비해, 서울 리전의 Vercel이 대신 호출한다.
// - 인증키는 Vercel 환경변수(KMA_SERVICE_KEY)에서 붙임 → 요청자에게 노출되지 않음
// - 허용한 서비스·기능·격자만 전달, Vercel CDN 5분 캐시
// 응답: 공공데이터포털 원문(JSON) 그대로

const SERVICES = {
  vilage: { base: 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0', ops: ['getVilageFcst', 'getUltraSrtNcst', 'getUltraSrtFcst'] },
  uv: { base: 'https://apis.data.go.kr/1360000/LivingWthrIdxServiceV5', ops: ['getUVIdxV5', 'getUVIdx'] },
  air: { base: 'http://apis.data.go.kr/B552584/ArpltnInforInqireSvc', ops: ['getMsrstnAcctoRltmMesureDnsty'] },
  station: { base: 'http://apis.data.go.kr/B552584/MsrstnInfoInqireSvc', ops: ['getTMStdrCrdnt', 'getNearbyMsrstnList'] },
};
const ALLOWED_GRIDS = new Set(['73,133', '61,127']); // config.json 지역 격자와 맞출 것
const PASS = ['pageNo', 'numOfRows', 'dataType', 'returnType', 'ver', 'base_date', 'base_time', 'nx', 'ny', 'areaNo', 'time', 'stationName', 'dataTerm', 'umdName', 'tmX', 'tmY'];

export const maxDuration = 30;

export async function GET(request) {
  const url = new URL(request.url);
  const svc = SERVICES[url.searchParams.get('svc')];
  const op = url.searchParams.get('op');
  const nx = url.searchParams.get('nx'), ny = url.searchParams.get('ny');
  const bad = (msg) => new Response(JSON.stringify({ error: msg }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  if (!svc || !svc.ops.includes(op)) return bad('not allowed');
  if ((nx || ny) && !ALLOWED_GRIDS.has(`${nx},${ny}`)) return bad('grid not allowed');

  const raw = (process.env.KMA_SERVICE_KEY || '').trim();
  const qs = new URLSearchParams({ serviceKey: raw.includes('%') ? decodeURIComponent(raw) : raw });
  for (const k of PASS) if (url.searchParams.has(k)) qs.set(k, url.searchParams.get(k));
  try {
    const res = await fetch(`${svc.base}/${op}?${qs}`, { signal: AbortSignal.timeout(25000) });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': res.ok ? 'max-age=300' : 'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
}
