/* 콕 찌르기 폰 알림 (Web Push). 사용자 2026-10-16 '접속 안 한 사람 찌르면 앱 밖으로 알람이 가서 나랑 놀자는 느낌'.
 * 게임이 꺼져 있어도 폰에 알림이 오게, 브라우저 푸시 서비스(FCM·Apple·Mozilla)로 암호화한 메시지를 보낸다.
 *   GET  /push/key                       → 서버 공개키 (VAPID, 처음 부를 때 만들어 저장)
 *   POST /push/sub  {name, sub}          → 이 이름으로 알림 받을 기기 등록 (이름마다 최근 기기 5대)
 *   POST /push/poke {from, to, ch}       → to 이름의 기기들에 '○○님이 콕 찔렀어요' 알림
 *   POST /push/admin {k, sub}            → 의견함 열쇠를 아는 기기 = 운영자. 채팅 신고가 오면 이 기기들에 알림 (v267, 사용자 2026-10-21 '신고당했으면 나한테 알려줘')
 *   POST /push/alert {who, text, by, ch} → 운영자 기기들에 '🚩 신고' 알림 ({kind:'crowd', n, where}면 '👥 사람 많음', {kind:'don', from, amt, cur, code}면 후원 들어옴 v294). index.js가 /fb/send 신고 뒤·방 입장 때 안에서만 부른다 (밖에서 온 /push/alert는 index.js가 막는다)
 * storage: get/put/delete 가 있는 저장소 (Durable Object storage 또는 테스트용 메모리).
 * 암호화: RFC 8291 (aes128gcm), 서명: RFC 8292 (VAPID, ES256). WebCrypto만 쓴다 (Worker·Node 둘 다 됨). */
import { KEY_HASH, sha } from './fb.js';
const enc = new TextEncoder();
const b64u = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const r = atob(s), b = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) b[i] = r.charCodeAt(i); return b; };
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const subtle = () => globalThis.crypto.subtle;

// 브라우저 회사 푸시 서버로만 보낸다 (아무 주소로나 요청을 보내게 하지 않으려고)
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
export const okEndpoint = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.test(x.hostname); } catch (e) { return false; } };

const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 20);

export async function vapid(storage) {
  let v = await storage.get('vapid');
  if (!v) {
    const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u(await subtle().exportKey('raw', kp.publicKey)), jwk: await subtle().exportKey('jwk', kp.privateKey) };
    await storage.put('vapid', v);
  }
  return v;
}

async function vapidHeader(v, endpoint, subject) {
  const aud = new URL(endpoint).origin, now = Math.floor(Date.now() / 1000);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))), body = b64u(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: subject })));
  const key = await subtle().importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body)); // WebCrypto는 r||s 64바이트 = JWT 형식 그대로
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
}

const hkdf = async (salt, ikm, info, len) => new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));

// RFC 8291: 받는 기기 공개키(p256dh)·비밀(auth)로 내용을 암호화한 aes128gcm 본문
export async function encrypt(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const eph = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  const uaKey = await subtle().importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 레코드 크기 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

export async function sendPush(v, sub, payload, opt = {}) {
  const body = await encrypt(sub, payload);
  const r = await (opt.fetch || fetch)(sub.endpoint, { method: 'POST', body, headers: {
    authorization: await vapidHeader(v, sub.endpoint, opt.subject || 'https://aspup100-sudo.github.io/auction-gta/'),
    'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(opt.ttl || 6 * 3600), urgency: 'high', topic: opt.topic || 'poke',
  } });
  return r.status;
}

const json = (o, status = 200, cors = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors } });

export const POKE_GAP_MS = 60000;      // 같은 사람을 다시 찌르려면 1분
export const POKE_PER_HOUR = 20;       // 한 사람이 한 시간에 받는 폰 알림 최대
export const ALERT_PER_HOUR = 30;      // 운영자 신고 알림 한 시간 최대 (신고 도배 막기)

export async function handlePush(req, storage, cors = {}, opt = {}) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '');
  const v = await vapid(storage);
  if (path === '/push/key') return json({ key: v.pub }, 200, cors);
  if (req.method !== 'POST') return json({ ok: false, why: 'method' }, 405, cors);
  let b = null; try { const t = await req.text(); if (t.length > 4000) throw 0; b = JSON.parse(t); } catch (e) { return json({ ok: false, why: 'bad' }, 400, cors); }
  const okSub = (s) => s && okEndpoint(s.endpoint) && s.keys && s.keys.p256dh && s.keys.auth && String(s.keys.p256dh).length <= 120 && String(s.keys.auth).length <= 40;
  if (path === '/push/admin') {
    if ((await sha(String(b.k || ''))) !== KEY_HASH) return json({ ok: false, why: 'key' }, 403, cors);
    const s = b.sub; if (!okSub(s)) return json({ ok: false, why: 'bad' }, 400, cors);
    const list = ((await storage.get('admins')) || []).filter(x => x.endpoint !== s.endpoint); list.unshift({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, at: Date.now() });
    await storage.put('admins', list.slice(0, 5)); return json({ ok: true }, 200, cors);
  }
  if (path === '/push/alert') {
    const now = Date.now(), hr = ((await storage.get('alertHour')) || []).filter(t => now - t < 3600000); if (hr.length >= ALERT_PER_HOUR) return json({ ok: false, why: 'busy' }, 200, cors);
    const list = (await storage.get('admins')) || []; if (!list.length) return json({ ok: false, why: 'none' }, 200, cors);
    const payload = b.kind === 'don' ? JSON.stringify({ t: 'don', from: cleanName(b.from), amt: String(b.amt || '').slice(0, 12), cur: String(b.cur || '').slice(0, 6), code: String(b.code || '').slice(0, 12), at: now }) : b.kind === 'crowd' ? JSON.stringify({ t: 'crowd', n: Math.max(0, Math.min(9999, Number(b.n) || 0)), where: cleanName(b.where), at: now }) : JSON.stringify({ t: 'report', who: cleanName(b.who), text: String(b.text || '').replace(/[<>]/g, '').slice(0, 80), by: cleanName(b.by), ch: String(b.ch || '').slice(0, 12), at: now });
    let sent = 0; const keep = [];
    for (const s of list) { let st = 0; try { st = await sendPush(v, s, payload, { ...opt, topic: b.kind === 'crowd' ? 'crowd' : b.kind === 'don' ? 'don' : 'report' }); } catch (e) { st = 0; } if (st >= 200 && st < 300) sent++; if (st !== 404 && st !== 410) keep.push(s); }
    if (sent) { hr.push(now); await storage.put('alertHour', hr); } if (keep.length !== list.length) await storage.put('admins', keep);
    return json({ ok: sent > 0, sent }, 200, cors);
  }
  if (path === '/push/sub') {
    const name = cleanName(b.name), s = b.sub || {};
    if (!name || !okEndpoint(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth || String(s.keys.p256dh).length > 120 || String(s.keys.auth).length > 40) return json({ ok: false, why: 'bad' }, 400, cors);
    const list = ((await storage.get('sub:' + name)) || []).filter(x => x.endpoint !== s.endpoint);
    list.unshift({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, at: Date.now() });
    await storage.put('sub:' + name, list.slice(0, 5));
    return json({ ok: true }, 200, cors);
  }
  if (path === '/push/poke') {
    const from = cleanName(b.from), to = cleanName(b.to), ch = Math.max(0, Math.min(999, Number(b.ch) || 0));
    if (!from || !to || from === to) return json({ ok: false, why: 'bad' }, 400, cors);
    const now = Date.now(), gk = 'gap:' + from + '>' + to, last = (await storage.get(gk)) || 0;
    if (now - last < POKE_GAP_MS) return json({ ok: false, why: 'soon', wait: Math.ceil((POKE_GAP_MS - (now - last)) / 1000) }, 200, cors);
    const list = (await storage.get('sub:' + to)) || [];
    if (!list.length) return json({ ok: false, why: 'none' }, 200, cors);
    const hk = 'hour:' + to, hr = ((await storage.get(hk)) || []).filter(t => now - t < 3600000);
    if (hr.length >= POKE_PER_HOUR) return json({ ok: false, why: 'busy' }, 200, cors);
    const payload = JSON.stringify({ t: 'poke', from, ch, at: now });
    let sent = 0; const keep = [];
    for (const s of list) {
      let st = 0; try { st = await sendPush(v, s, payload, opt); } catch (e) { st = 0; }
      if (st >= 200 && st < 300) sent++;
      if (st !== 404 && st !== 410) keep.push(s); // 지운 구독(앱 삭제·알림 끔)은 목록에서 뺀다
    }
    if (sent) { await storage.put(gk, now); hr.push(now); await storage.put(hk, hr); } // 실제로 간 것만 센다
    if (keep.length !== list.length) { if (keep.length) await storage.put('sub:' + to, keep); else await storage.delete('sub:' + to); }
    return json({ ok: sent > 0, sent, why: sent ? '' : (keep.length ? 'fail' : 'none') }, 200, cors);
  }
  return json({ ok: false, why: 'path' }, 404, cors);
}
