/* 경매 GTA 중계 서버 (Cloudflare Worker + Durable Object)
 * 주소: wss://<worker>/ch/<채널 번호>?id=<플레이어 id>&name=<이름>  (실시간 채널)
 *       wss://<worker>/room/<방 코드>?id=...&name=...                (친구 방)
 *       GET /health → ok
 * 채널·방마다 Durable Object 하나가 떠서 그 방의 사람들을 잇는다. WebSocket 절전(hibernation) API라 아무도 말을 안 하면 비용이 거의 없다.
 */
import { RoomLogic, TICK_MS } from './room.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return new Response('auction-gta relay ok', { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
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
  sock(ws, a) { return { ws, id: a.id, name: a.name, send: d => ws.send(d), close: () => { try { ws.close(1000, 'replaced'); } catch (e) {} } }; }
  ensure(kind, key) {
    if (this.logic) return this.logic;
    if (!this.meta && kind) { this.meta = { kind, key }; this.ctx.storage.put('meta', this.meta); }
    const meta = this.meta || { kind: 'ch', key: '0' };
    this.logic = new RoomLogic({ kind: meta.kind, key: meta.key, storage: this.ctx.storage, sockets: () => this.sockets() });
    return this.logic;
  }
  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/(ch|room)\/([A-Za-z0-9_-]{1,16})\/?$/); if (!m) return new Response('not found', { status: 404 });
    const kind = m[1], key = kind === 'ch' ? String(Number(m[2]) || 0) : m[2].toUpperCase();
    const id = (url.searchParams.get('id') || '').slice(0, 24) || 'g' + Math.random().toString(36).slice(2, 8);
    const name = (url.searchParams.get('name') || '').trim().slice(0, 20) || '플레이어';
    const logic = this.ensure(kind, key); await logic.load();
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    server.serializeAttachment({ id, name });
    this.ctx.acceptWebSocket(server);
    await logic.join(this.sock(server, { id, name }));
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 4000) return;
    let a = null; try { a = ws.deserializeAttachment(); } catch (e) {} if (!a) return;
    await this.ensure().message(this.sock(ws, a), data);
  }
  async webSocketClose(ws) { let a = null; try { a = ws.deserializeAttachment(); } catch (e) {} try { ws.close(); } catch (e) {} if (a) await this.ensure().close(this.sock(ws, a)); }
  async webSocketError(ws) { return this.webSocketClose(ws); }
  async alarm() {
    const logic = this.ensure(); const n = await logic.tick();
    if (n) await this.ctx.storage.setAlarm(Date.now() + TICK_MS); else await logic.persist(true); // 아무도 없으면 알람을 멈춘다 (다음 접속 때 다시 켠다)
  }
}
