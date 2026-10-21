/* 후원 확인 (v294, 사용자 2026-10-21 '후원해 준 사람만 용돈 주고 절하는 거' → 'Kofi 이거 해볼까'):
 *   POST /kofi                    ← Ko-fi 웹훅 (form data=JSON). verification_token의 SHA-256이 KOFI_HASH와 같아야 받는다.
 *                                   메시지에서 AUC-XXXXXX 코드를 (예전 GTA-도 같은 코드로 받는다) 찾아 그 코드를 후원자로 적는다. 코드가 없으면 '코드 없는 후원'으로만 남긴다.
 *   GET  /don/me?s=<기기 비밀값>   → {ok, code, donor}. 코드 = 비밀값 SHA-256 앞자리 (게임이 응원 창에 보여 준다). 비밀값은 그 기기만 안다.
 *   GET  /don/list?k=<열쇠>        → 받은 후원 목록 (HTML). 열쇠는 의견함 열쇠와 같다
 *   GET  /don/grant?k=<열쇠>&c=AUC-XXXXXX → 코드 없이 온 후원을 손으로 연결
 * 남이 Ko-fi 공개 메시지에서 코드를 베껴도 비밀값이 없어서 못 쓴다. */
import { KEY_HASH, sha } from './fb.js';
export const KOFI_HASH = 'aeb6b359098d9479c8747ce5f322b3687c00f49854443ca75bd65a5de5e6a217'; // Ko-fi Verification Token의 SHA-256. 비어 있으면 웹훅을 받지 않는다
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function codeOf(secret) { const h = await sha('gta-don:' + secret); let c = ''; for (let i = 0; i < 6; i++) c += ABC[parseInt(h.slice(i * 2, i * 2 + 2), 16) % ABC.length]; return 'AUC-' + c; } // v297 사용자 '코드 GTA 말고 다른 걸로 (저작권)'
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kst = (t) => new Date(t + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
const LOG_MAX = 300;

export async function isDonor(storage, secret) { if (!secret || secret.length < 16) return false; const d = (await storage.get('donors')) || {}; return !!d[await codeOf(secret)]; }

export async function handleDon(req, storage, CORS, onDonation, kofiHash = KOFI_HASH) {
  const url = new URL(req.url), J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...CORS } });
  if (url.pathname === '/kofi' && req.method === 'POST') {
    let raw = await req.text(), b = null;
    try { const f = new URLSearchParams(raw); b = JSON.parse(f.get('data') || raw); } catch (e) {}
    if (!b || typeof b !== 'object') return J({ ok: false }, 400);
    if (!kofiHash || (await sha(String(b.verification_token || ''))) !== kofiHash) return J({ ok: false }, 403);
    const log = (await storage.get('donLog')) || [];
    if (b.message_id && log.some(e => e.id === b.message_id)) return J({ ok: true, dup: true }); // Ko-fi가 같은 걸 다시 보낼 때
    const m = String(b.message || '').toUpperCase().match(/(?:AUC|GTA)[-\s]?([A-Z0-9]{6})/), code = m ? 'AUC-' + m[1] : '';
    const e = { id: clean(b.message_id, 60), at: Date.now(), from: clean(b.from_name, 30), amt: clean(b.amount, 12), cur: clean(b.currency, 6), type: clean(b.type, 20), msg: clean(b.message, 200), code };
    log.push(e); while (log.length > LOG_MAX) log.shift(); await storage.put('donLog', log);
    if (code) { const d = (await storage.get('donors')) || {}; d[code] = d[code] || { at: e.at }; await storage.put('donors', d); }
    if (onDonation) await onDonation(e);
    return J({ ok: true });
  }
  if (url.pathname === '/don/me' && req.method === 'GET') {
    const s = String(url.searchParams.get('s') || '').slice(0, 64); if (s.length < 16) return J({ ok: false }, 400);
    const code = await codeOf(s), d = (await storage.get('donors')) || {};
    return J({ ok: true, code, donor: !!d[code] });
  }
  if ((url.pathname === '/don/list' || url.pathname === '/don/grant') && req.method === 'GET') {
    const k = url.searchParams.get('k') || '';
    if ((await sha(k)) !== KEY_HASH) return new Response('열쇠가 맞지 않아요', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const d = (await storage.get('donors')) || {};
    if (url.pathname === '/don/grant') {
      const m = String(url.searchParams.get('c') || '').toUpperCase().match(/(?:AUC|GTA)[-\s]?([A-Z0-9]{6})/); if (!m) return J({ ok: false }, 400);
      d['AUC-' + m[1]] = d['AUC-' + m[1]] || { at: Date.now(), hand: 1 }; await storage.put('donors', d);
      return Response.redirect(url.origin + '/don/list?k=' + encodeURIComponent(k), 302);
    }
    const log = ((await storage.get('donLog')) || []).slice().reverse();
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>경매 GTA 후원</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f3ea;color:#222;margin:0;padding:16px;max-width:760px;margin:auto}h1{font-size:20px}.r{background:#fff;border-radius:10px;padding:10px 12px;margin:8px 0;box-shadow:0 1px 3px rgba(0,0,0,.12);border-left:5px solid #2a8}.r.no{border-left-color:#d93}.m{font-size:12px;color:#777}.t{white-space:pre-wrap;margin:4px 0}form{display:flex;gap:6px;margin:10px 0}input{flex:1;font-size:16px;padding:8px}button{font-size:16px;padding:8px 12px}</style>
<h1>경매 GTA 후원 <small>(${log.length}번 · 확인된 코드 ${Object.keys(d).length}개)</small></h1>
<p class="m">코드 없이 온 후원은 그 사람한테 응원 창의 코드를 받아서 아래에 넣으면 열려요.</p>
<form action="/don/grant"><input type="hidden" name="k" value="${esc(k)}"><input name="c" placeholder="AUC-XXXXXX"><button>열어 주기</button></form>
${log.map(e => `<div class="r${e.code ? '' : ' no'}"><div class="m">${esc(kst(e.at))} · ${esc(e.from || '이름 없음')} · ${esc(e.amt)} ${esc(e.cur)} · ${esc(e.type)}</div><div>${e.code ? '열림: <b>' + esc(e.code) + '</b>' : '코드 없음'}</div>${e.msg ? `<div class="t">${esc(e.msg)}</div>` : ''}</div>`).join('') || '<p>아직 없어요.</p>'}`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return J({ ok: false }, 404);
}
