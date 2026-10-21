/* 기록 옮기기 (v265, 사용자 2026-10-21): 이 폰의 기록을 서버에 잠깐 맡기고 짧은 코드(8자리)를 받는다 → 다른 폰에서 그 코드로 받아 간다.
 *   POST /sv/put {d}        → {ok, code}   (d = 게임이 줄여 만든 글자, 최대 1.5MB. 3일 보관)
 *   GET  /sv/get?c=<코드>   → {ok, d}
 * 큰 값은 90KB 조각으로 나눠 저장한다 (Durable Object 저장 한 칸 크기 제한 때문). */
const KEEP_MS = 3 * 24 * 3600e3, MAX = 1.5e6, PIECE = 90000, MAX_CODES = 3000;
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(O·0·I·1) 뺐다
const mkCode = () => { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); return [...b].map(x => ABC[x % ABC.length]).join(''); };

export async function handleSv(req, storage, CORS) {
  const url = new URL(req.url), J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...CORS } });
  if (url.pathname === '/sv/put' && req.method === 'POST') {
    let b = null; try { b = JSON.parse(await req.text()); } catch (e) {} const d = b && typeof b.d === 'string' ? b.d : ''; if (!d || d.length > MAX) return J({ ok: false, why: d ? 'big' : 'empty' }, 400);
    const now = Date.now(); let idx = (await storage.get('svIdx')) || [];
    const old = idx.filter(e => now - e.at > KEEP_MS || idx.length > MAX_CODES && e === idx[0]); for (const e of old) for (let i = 0; i < e.n; i++) await storage.delete('sv:' + e.c + ':' + i);
    idx = idx.filter(e => !old.includes(e));
    let code = mkCode(); while (idx.some(e => e.c === code)) code = mkCode();
    const n = Math.ceil(d.length / PIECE); for (let i = 0; i < n; i++) await storage.put('sv:' + code + ':' + i, d.slice(i * PIECE, (i + 1) * PIECE));
    idx.push({ c: code, at: now, n }); await storage.put('svIdx', idx);
    return J({ ok: true, code, days: 3 });
  }
  if (url.pathname === '/sv/get' && req.method === 'GET') {
    const c = String(url.searchParams.get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); const idx = (await storage.get('svIdx')) || [], e = idx.find(x => x.c === c);
    if (!e || Date.now() - e.at > KEEP_MS) return J({ ok: false, why: 'none' }, 404);
    let d = ''; for (let i = 0; i < e.n; i++) d += (await storage.get('sv:' + c + ':' + i)) || '';
    return J({ ok: true, d });
  }
  return J({ ok: false }, 404);
}
