/* 의견함 · 채팅 신고 (v265, 사용자 2026-10-21 '다른 건 다 만들어': 의견 보내기 버튼 + 채팅 신고)
 *   POST /fb/send {kind:'idea'|'report', text, by, ch, ver, who, ctx}  → 저장 (하루 묶음, 하루 300개까지, 60일 보관)
 *   GET  /fb/list?k=<열쇠>                                            → 모아 보기 (HTML). 열쇠는 개발자만 안다 (여기엔 SHA-256 값만)
 * storage: get/put/delete 가 있는 저장소 (Durable Object storage 또는 테스트용 메모리). */
export const KEY_HASH = 'c12970f04ed6702d4cbc8112fd45d1295438518e07c8186e3808e80c0bfe4493';
const DAY_MAX = 300, KEEP_DAYS = 60;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function sha(s) { const b = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
const kst = (t) => new Date(t + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);

export async function handleFb(req, storage, CORS) {
  const url = new URL(req.url), J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...CORS } });
  if (url.pathname === '/fb/send' && req.method === 'POST') {
    let b = null; try { b = JSON.parse(await req.text()); } catch (e) {} if (!b || typeof b !== 'object') return J({ ok: false }, 400);
    const kind = b.kind === 'report' ? 'report' : 'idea', text = clean(b.text, 500); if (!text) return J({ ok: false }, 400);
    const e = { at: Date.now(), kind, text, by: clean(b.by, 20), ch: clean(b.ch, 12), ver: clean(b.ver, 12), who: clean(b.who, 20), ctx: Array.isArray(b.ctx) ? b.ctx.slice(-6).map(x => clean(x, 90)) : [] };
    const day = kst(e.at).slice(0, 10), k = 'fb:' + day, L = (await storage.get(k)) || [];
    if (L.length >= DAY_MAX) return J({ ok: false, full: true }, 429);
    L.push(e); await storage.put(k, L);
    let days = (await storage.get('fbDays')) || []; if (!days.includes(day)) { days.push(day); days.sort(); while (days.length > KEEP_DAYS) { await storage.delete('fb:' + days.shift()); } await storage.put('fbDays', days); }
    return J({ ok: true });
  }
  if (url.pathname === '/fb/list' && req.method === 'GET') {
    if ((await sha(url.searchParams.get('k') || '')) !== KEY_HASH) return new Response('열쇠가 맞지 않아요', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const days = ((await storage.get('fbDays')) || []).slice().reverse(), rows = [];
    for (const d of days) { const L = (await storage.get('fb:' + d)) || []; for (let i = L.length - 1; i >= 0; i--) rows.push(L[i]); }
    if (url.searchParams.get('json')) return J(rows);
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>경매 GTA 의견함</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f3ea;color:#222;margin:0;padding:16px;max-width:760px;margin:auto}h1{font-size:20px}.r{background:#fff;border-radius:10px;padding:10px 12px;margin:8px 0;box-shadow:0 1px 3px rgba(0,0,0,.12)}.r.report{border-left:5px solid #d33}.r.idea{border-left:5px solid #2a8}.m{font-size:12px;color:#777}.t{white-space:pre-wrap;margin:4px 0}.c{font-size:12px;color:#555;background:#f2f2f2;border-radius:6px;padding:4px 8px}</style>
<h1>경매 GTA 의견함 <small>(${rows.length}개 · 새것부터)</small></h1>
${rows.map(e => `<div class="r ${e.kind}"><div class="m">${e.kind === 'report' ? '🚩 채팅 신고' : '💬 의견'} · ${esc(kst(e.at))} · ${esc(e.by || '이름 없음')}${e.ch ? ' · 채널 ' + esc(e.ch) : ''}${e.ver ? ' · ' + esc(e.ver) : ''}</div>${e.who ? `<div class="m">신고한 상대: <b>${esc(e.who)}</b></div>` : ''}<div class="t">${esc(e.text)}</div>${e.ctx && e.ctx.length ? `<div class="c">${e.ctx.map(esc).join('<br>')}</div>` : ''}</div>`).join('') || '<p>아직 아무것도 없어요.</p>'}`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return J({ ok: false }, 404);
}
