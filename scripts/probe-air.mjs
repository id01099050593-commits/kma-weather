// 확인용: 에어코리아(측정소·대기오염)와 생활기상지수(자외선) API 응답 점검, 가까운 측정소 찾기
// 사용: KMA_SERVICE_KEY=... node scripts/probe-air.mjs
const raw = (process.env.KMA_SERVICE_KEY || '').trim();
const key = raw.includes('%') ? decodeURIComponent(raw) : raw;
const pad = (n) => String(n).padStart(2, '0');
const k = new Date(Date.now() + 9 * 3600e3);
const ymd = `${k.getUTCFullYear()}${pad(k.getUTCMonth() + 1)}${pad(k.getUTCDate())}`;

async function get(url, params) {
  const qs = new URLSearchParams({ serviceKey: key, ...params });
  const res = await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
}
const show = (label, v) => console.log(`\n=== ${label} ===\n${JSON.stringify(v, null, 1).slice(0, 1500)}`);

const AIR = 'https://apis.data.go.kr/B552584';
for (const umd of ['효자동', '황학동']) {
  const tm = await get(`${AIR}/MsrstnInfoInqireSvc/getTMStdrCrdnt`, { umdName: umd, returnType: 'json', numOfRows: '20', pageNo: '1' });
  const items = tm?.response?.body?.items ?? [];
  show(`TM 좌표 ${umd}`, tm.raw ?? items.map((i) => `${i.sidoName} ${i.sggName} ${i.umdName} tmX=${i.tmX} tmY=${i.tmY}`));
  for (const it of items.filter((i) => /춘천|중구/.test(i.sggName))) {
    const near = await get(`${AIR}/MsrstnInfoInqireSvc/getNearbyMsrstnList`, { tmX: it.tmX, tmY: it.tmY, returnType: 'json', ver: '1.1' });
    const st = near?.response?.body?.items ?? [];
    show(`가까운 측정소 (${it.sggName} ${umd})`, near.raw ?? st.map((s) => `${s.stationName} ${s.tm}km ${s.addr}`));
    if (st[0]) {
      const air = await get(`${AIR}/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty`, {
        stationName: st[0].stationName, dataTerm: 'DAILY', returnType: 'json', ver: '1.3', numOfRows: '1', pageNo: '1',
      });
      show(`실시간 대기 (${st[0].stationName})`, air.raw ?? air?.response?.body?.items?.[0] ?? air);
    }
  }
}

// 자외선 지수: 06시·18시 발표
const base = k.getUTCHours() >= 18 ? `${ymd}18` : k.getUTCHours() >= 6 ? `${ymd}06` : null;
for (const [name, areaNo] of [['춘천시', '5111000000'], ['춘천시(구코드)', '4211000000'], ['서울 중구', '1114000000']]) {
  const uv = await get('https://apis.data.go.kr/1360000/LivingWthrIdxServiceV4/getUVIdxV4', {
    pageNo: '1', numOfRows: '10', dataType: 'JSON', areaNo, time: base ?? `${ymd}06`,
  });
  show(`자외선 ${name} ${areaNo} time=${base}`, uv.raw ?? uv?.response ?? uv);
}
