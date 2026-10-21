/* 경매 GTA 중계 서버 (Cloudflare Worker + Durable Object)
 * 주소: wss://<worker>/ch/<채널 번호>?id=<플레이어 id>&name=<이름>  (실시간 채널)
 *       wss://<worker>/room/<방 코드>?id=...&name=...                (친구 방)
 *       GET /health → ok
 *       /push/key · /push/sub · /push/poke → 콕 찌르기 폰 알림 (src/push.js)
 *       /fb/send · /fb/list?k=… → 의견함·채팅 신고 (src/fb.js). 신고면 운영자 폰에 알림 (/push/alert, 안에서만)
 *       /sv/put · /sv/get?c=… → 기록 옮기기 코드 (src/sv.js)
 *       POST /kofi · /don/me · /don/list → Ko-fi 후원 확인 (src/don.js). 후원자가 아니면 플레이어끼리 용돈(tip)은 서버가 버린다
 * 채널·방마다 Durable Object 하나가 떠서 그 방의 사람들을 잇는다. WebSocket 절전(hibernation) API라 아무도 말을 안 하면 비용이 거의 없다.
 */
import { RoomLogic, TICK_MS } from './room.js';
import { handlePush } from './push.js';
import { handleFb } from './fb.js';
import { handleSv } from './sv.js';
import { handleDon } from './don.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': '*' };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return new Response('auction-gta relay ok', { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    if (url.pathname.replace(/\/+$/, '') === '/push/alert') return new Response('not found', { status: 404, headers: CORS }); // 운영자 알림은 아래 신고 처리에서만
    if (url.pathname.startsWith('/push/')) return env.ROOMS.get(env.ROOMS.idFromName('push:hub')).fetch(req);
    if (url.pathname === '/fb/send' && req.method === 'POST') { // v267: 신고가 저장되면 운영자 폰에 알림
      const body = await req.text(), r = await env.ROOMS.get(env.ROOMS.idFromName('fb:hub')).fetch(new Request(req.url, { method: 'POST', body }));
      let b = null; try { b = JSON.parse(body); } catch (e) {}
      if (r.ok && b && b.kind === 'report') ctx.waitUntil(env.ROOMS.get(env.ROOMS.idFromName('push:hub')).fetch(new Request(url.origin + '/push/alert', { method: 'POST', body: JSON.stringify({ who: b.who, text: b.text, by: b.by, ch: b.ch }) })).catch(() => {}));
      return r;
    }
    if (url.pathname.startsWith('/fb/')) return env.ROOMS.get(env.ROOMS.idFromName('fb:hub')).fetch(req); // 의견함도 Durable Object 하나에
    if (url.pathname === '/kofi' || url.pathname.startsWith('/don/')) return env.ROOMS.get(env.ROOMS.idFromName('don:hub')).fetch(req); // v294 후원 확인
    if (url.pathname.startsWith('/sv/')) return env.ROOMS.get(env.ROOMS.idFromName('sv:hub')).fetch(req); // 기록 옮기기 코드 // 콕 알림: 구독 목록은 Durable Object 하나에 모은다
    const m = url.pathname.match(/^\/(ch|room)\/([A-Za-z0-9_-]{1,16})\/?$/);
    if (!m) return new Response('not found', { status: 404, headers: CORS });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426, headers: CORS });
    const kind = m[1], key = kind === 'ch' ? String(Number(m[2]) || 0) : m[2].toUpperCase();
    const id = env.ROOMS.idFromName(kind + ':' + key);
    return env.ROOMS.get(id).fetch(req);
  },
};

export class ChannelRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.logic = null;
    this.ctx.blockConcurrencyWhile(async () => { this.meta = (await this.ctx.storage.get('meta')) || null; });
  }
  sockets() {
    return this.ctx.getWebSockets().map(ws => { let a = null; try { a = ws.deserializeAttachment(); } catch (e) {} if (!a) return null; return this.sock(ws, a); }).filter(Boolean);
  }
  async donor(ds) { try { const r = await this.env.ROOMS.get(this.env.ROOMS.idFromName('don:hub')).fetch(new Request('https://relay/don/me?s=' + encodeURIComponent(ds))); const j = await r.json(); return !!j.donor; } catch (e) { return false; } }
  sock(ws, a) { return { ws, id: a.id, name: a.name, send: d => ws.send(d), close: () => { try { ws.close(1000, 'replaced'); } catch (e) {} } }; }
  ensure(kind, key) {
    if (this.logic) return this.logic;
    if (!this.meta && kind) { this.meta = { kind, key }; this.ctx.storage.put('meta', this.meta); }
    const meta = this.meta || { kind: 'ch', key: '0' };
    this.logic = new RoomLogic({ kind: meta.kind, key: meta.key, storage: this.ctx.storage, sockets: () => this.sockets(),
      onCrowd: (n, where) => this.env.ROOMS.get(this.env.ROOMS.idFromName('push:hub')).fetch(new Request('https://relay/push/alert', { method: 'POST', body: JSON.stringify({ kind: 'crowd', n, where }) })) }); // 사람 많으면 운영자 폰에
    return this.logic;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/push/')) return handlePush(req, this.ctx.storage, CORS);
    if (url.pathname.startsWith('/fb/')) return handleFb(req, this.ctx.storage, CORS);
    if (url.pathname.startsWith('/sv/')) return handleSv(req, this.ctx.storage, CORS);
    if (url.pathname === '/kofi' || url.pathname.startsWith('/don/')) return handleDon(req, this.ctx.storage, CORS, e => this.env.ROOMS.get(this.env.ROOMS.idFromName('push:hub')).fetch(new Request('https://relay/push/alert', { method: 'POST', body: JSON.stringify({ kind: 'don', from: e.from, amt: e.amt, cur: e.cur, code: e.code }) })).catch(() => {}));
    const m = url.pathname.match(/^\/(ch|room)\/([A-Za-z0-9_-]{1,16})\/?$/); if (!m) return new Response('not found', { status: 404 });
    const kind = m[1], key = kind === 'ch' ? String(Number(m[2]) || 0) : m[2].toUpperCase();
    const id = (url.searchParams.get('id') || '').slice(0, 24) || 'g' + Math.random().toString(36).slice(2, 8);
    const name = (url.searchParams.get('name') || '').trim().slice(0, 20) || '플레이어';
    const logic = this.ensure(kind, key); await logic.load();
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    const ds = (url.searchParams.get('ds') || '').slice(0, 64), don = ds ? await this.donor(ds) : false; // v294 후원자만 용돈
    server.serializeAttachment({ id, name, ds, don });
    this.ctx.acceptWebSocket(server);
    await logic.join(this.sock(server, { id, name }));
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 4000) return;
    let a = null; try { a = ws.deserializeAttachment(); } catch (e) {} if (!a) return;
    if (data.includes('"t":"tip"') && !a.don) { if (!a.ds || !(await this.donor(a.ds))) return; a.don = true; ws.serializeAttachment(a); } // v294 후원 안 한 사람의 용돈은 안 보낸다 (중간에 후원하면 다시 물어본다)
    await this.ensure().message(this.sock(ws, a), data);
  }
  async webSocketClose(ws) { let a = null; try { a = ws.deserializeAttachment(); } catch (e) {} try { ws.close(); } catch (e) {} if (a) await this.ensure().close(this.sock(ws, a)); }
  async webSocketError(ws) { return this.webSocketClose(ws); }
  async alarm() {
    const logic = this.ensure(); const n = await logic.tick();
    if (n) await this.ctx.storage.setAlarm(Date.now() + TICK_MS); else await logic.persist(true); // 아무도 없으면 알람을 멈춘다 (다음 접속 때 다시 켠다)
  }
}
