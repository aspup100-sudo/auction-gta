// 로컬 테스트용 중계 서버 (Node + ws). 실제 배포는 Cloudflare Worker(src/index.js)로 하지만 방 규칙(src/room.js)은 같다.
// 실행: npm install && node test-server.js [포트=8787]  → 게임에서 FEEL.relayUrl = 'http://127.0.0.1:8787'
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { RoomLogic, TICK_MS } from './src/room.js';
import { handlePush } from './src/push.js';
import { handleFb } from './src/fb.js';
import { handleSv } from './src/sv.js';

const port = Number(process.argv[2]) || 8787;
const rooms = new Map(); // 'ch:1' → { logic, socks: Set }
const memStore = () => { const m = new Map(); return { async get(k) { return m.get(k); }, async put(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); }, async delete(k) { m.delete(k); } }; };
const CORS0 = {};
const testFetch = async (u, o) => { console.log('push →', u, o && o.headers && o.headers.topic); return { status: 201 }; }; // 테스트: 진짜 푸시 서버 대신 찍기만
const pushStore = memStore(), fbStore = memStore(), svStore = memStore();
const roomFor = (kind, key) => {
  const id = kind + ':' + key; if (rooms.has(id)) return rooms.get(id);
  const r = { socks: new Set() }; r.logic = new RoomLogic({ kind, key, storage: memStore(), sockets: () => [...r.socks], onCrowd: (n, where) => handlePush(new Request('http://x/push/alert', { method: 'POST', body: JSON.stringify({ kind: 'crowd', n, where }) }), pushStore, CORS0, { fetch: testFetch }).then(x => x.text()).then(t => console.log('crowd', n, where, t)) });
  r.timer = setInterval(() => r.logic.tick().catch(() => {}), TICK_MS); rooms.set(id, r); return r;
};
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/push/') || req.url.startsWith('/fb/') || req.url.startsWith('/sv/')) { // 콕 알림 (src/push.js와 같은 처리, 저장은 메모리)
    const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    if (req.url.replace(/[?#].*/, '').replace(/\/+$/, '') === '/push/alert') { res.writeHead(404, CORS); return res.end('not found'); } // 운영자 알림은 신고 처리에서만 (index.js와 같게)
    const rq = new Request('http://x' + req.url, { method: req.method, body: req.method === 'POST' ? body : undefined }), r = req.url.startsWith('/fb/') ? await handleFb(rq, fbStore, CORS) : req.url.startsWith('/sv/') ? await handleSv(rq, svStore, CORS) : await handlePush(rq, pushStore, CORS);
    if (req.url.startsWith('/fb/send') && r.ok) { let b = null; try { b = JSON.parse(body); } catch (e) {} if (b && b.kind === 'report') handlePush(new Request('http://x/push/alert', { method: 'POST', body: JSON.stringify({ who: b.who, text: b.text, by: b.by, ch: b.ch }) }), pushStore, CORS, { fetch: testFetch }).then(x => x.text()).then(t => console.log('alert', t)).catch(e => console.log('alert err', e.message)); }
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(await r.text());
  }
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('auction-gta relay (test) ok'); });
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
