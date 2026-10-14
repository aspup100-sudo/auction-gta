// 로컬 테스트용 중계 서버 (Node + ws). 실제 배포는 Cloudflare Worker(src/index.js)로 하지만 방 규칙(src/room.js)은 같다.
// 실행: npm install && node test-server.js [포트=8787]  → 게임에서 FEEL.relayUrl = 'http://127.0.0.1:8787'
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { RoomLogic, TICK_MS } from './src/room.js';

const port = Number(process.argv[2]) || 8787;
const rooms = new Map(); // 'ch:1' → { logic, socks: Set }
const memStore = () => { const m = new Map(); return { async get(k) { return m.get(k); }, async put(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); } }; };
const roomFor = (kind, key) => {
  const id = kind + ':' + key; if (rooms.has(id)) return rooms.get(id);
  const r = { socks: new Set() }; r.logic = new RoomLogic({ kind, key, storage: memStore(), sockets: () => [...r.socks] });
  r.timer = setInterval(() => r.logic.tick().catch(() => {}), TICK_MS); rooms.set(id, r); return r;
};
const server = http.createServer((req, res) => { res.setHeader('access-control-allow-origin', '*'); res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('auction-gta relay (test) ok'); });
const wss = new WebSocketServer({ server });
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://x'); const m = url.pathname.match(/^\/(ch|room)\/([A-Za-z0-9_-]{1,16})\/?$/); if (!m) return ws.close(1008, 'bad path');
  const kind = m[1], key = kind === 'ch' ? String(Number(m[2]) || 0) : m[2].toUpperCase();
  const id = (url.searchParams.get('id') || '').slice(0, 24) || 'g' + Math.random().toString(36).slice(2, 8);
  const name = (url.searchParams.get('name') || '').trim().slice(0, 20) || '플레이어';
  const r = roomFor(kind, key);
  const s = { ws, id, name, send: d => { if (ws.readyState === 1) ws.send(d); }, close: () => ws.close(1000, 'replaced') };
  r.socks.add(s); await r.logic.join(s);
  ws.on('message', d => { const t = d.toString(); if (t.length <= 4000) r.logic.message(s, t).catch(() => {}); });
  ws.on('close', () => { r.socks.delete(s); r.logic.close(s).catch(() => {}); });
  ws.on('error', () => {});
});
server.listen(port, '127.0.0.1', () => console.log('relay test server on http://127.0.0.1:' + port));
