/* 경매 GTA 중계 서버: 방 하나(실시간 채널 N 또는 친구 방 코드)의 규칙.
 * Cloudflare Durable Object(index.js)와 로컬 테스트 서버(test-server.js)가 같이 쓴다.
 * 서버는 채널의 '방장' 역할만 한다: 들어온 사람 목록, 입찰표 장부(lbid), 순위표(seen)를 들고 있다가 새로 온 사람에게 주고,
 * 나머지 메시지(위치·채팅·충돌·입찰)는 보낸 사람만 빼고 모두에게 그대로 전달한다. 게임 규칙(개찰·정산)은 서버가 모른다.
 */
export const BOOK_KEEP_MS = 3 * 3600e3;      // 입찰표 장부: 이보다 오래된 회차는 지운다 (1주 = 20분이라 넉넉)
export const SEEN_KEEP_MS = 30 * 86400e3;    // 순위표: 30일 동안 안 들어온 사람은 지운다
export const SEEN_MAX = 300;
// 이미 기록을 지운 이름 (v178 전에 지워서 순위표에 남은 것): 서버가 처음 읽을 때 한 번 뺀다
const PURGE = [];
export const TICK_MS = 10000;                // 심장박동·순위표 공유 간격
export const MINE_MAX = 12000, MINE_LIM = 250; // 석탄 땅굴 (v168): 채널마다 굴 하나. 판 칸('x,y')과 마지막 막장 [x,y,방향]을 들고 있다가 새로 온 광부에게 준다

export class RoomLogic {
  // opts: { kind: 'ch'|'room', key, storage: { get(k), put(k, v) }, sockets: () => [{ ws, id, name, send(str), close() }], now?: () => ms }  (ws = 같은 연결인지 비교용 원본 소켓)
  constructor(opts) {
    this.kind = opts.kind; this.key = opts.key; this.storage = opts.storage; this.sockets = opts.sockets; this.now = opts.now || (() => Date.now());
    this.book = null; this.seen = null; this.tomb = null; this.hostId = null; this.dirty = false; this.loaded = null; this.mcells = null; this.mlast = null; this.mdirty = false;
  }
  async load() {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      this.book = (await this.storage.get('book')) || {}; this.seen = (await this.storage.get('seen')) || {}; this.tomb = (await this.storage.get('tomb')) || {}; for (const nm of PURGE) if (this.seen[nm]) { delete this.seen[nm]; this.tomb[nm] = this.now(); this.dirty = true; } this.hostId = (await this.storage.get('hostId')) || null;
      const mn = await this.storage.get('mine'); this.mcells = new Set(mn && typeof mn.c === 'string' && mn.c ? mn.c.split(';') : []); this.mlast = mn && Array.isArray(mn.l) ? mn.l : null;
    })();
    return this.loaded;
  }
  async persist(force) {
    if (!this.dirty && !force) return; this.dirty = false;
    await this.storage.put('book', this.book); await this.storage.put('seen', this.seen); await this.storage.put('tomb', this.tomb); await this.storage.put('hostId', this.hostId);
    if (this.mdirty) { this.mdirty = false; await this.storage.put('mine', { c: [...this.mcells].join(';'), l: this.mlast }); }
  }
  // 같은 id가 다시 붙으면(재연결) 먼저 것은 닫는다. 서버는 손님 목록을 소켓에서 바로 읽으므로 따로 들고 있지 않는다.
  async join(s) {
    await this.load();
    for (const o of this.sockets()) if (o.ws !== s.ws && o.id === s.id) { try { o.close(); } catch (e) {} }
  }
  players(except) { const l = []; const seen = new Set(); for (const s of this.sockets()) { if ((except && s.ws === except.ws) || seen.has(s.id)) continue; seen.add(s.id); l.push({ id: s.id, name: s.name }); } return l; }
  broadcast(m, except) { const str = JSON.stringify(m); for (const s of this.sockets()) { if (except && s.ws === except.ws) continue; try { s.send(str); } catch (e) {} } }
  sendPlayers() { this.broadcast({ t: 'players', list: this.players(), from: 'server', name: '서버' }); }
  async message(s, text) {
    await this.load();
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    m.from = s.id; m.name = s.name; // 보낸 사람은 서버가 보증한다
    if (m.t === 'ping') return;
    if (m.t === 'hello') {
      if (this.kind === 'room') {
        if (m.host) { this.hostId = s.id; this.dirty = true; }
        else { const hostOn = this.hostId && this.sockets().some(x => x.id === this.hostId && x.ws !== s.ws); if (!hostOn) { try { s.send(JSON.stringify({ t: 'noroom', from: 'server', name: '서버' })); s.close(); } catch (e) {} return; } }
        this.broadcast(m, s); // 방장 클라이언트가 init(시드·자본)를 보낸다
      }
      this.sendPlayers();
      if (this.kind === 'ch') { this.touchSeen(s.name, m.cash, m.pn, undefined, m.ea); try { s.send(JSON.stringify({ t: 'lbook', book: this.book, seen: this.seen, gone: this.tomb, from: 'server', name: '서버' })); } catch (e) {} }
      return;
    }
    if (m.t === 'bye') { this.broadcast(m, s); return; }
    if (m.t === 'getbook') { if (this.kind === 'ch') try { s.send(JSON.stringify({ t: 'lbook', book: this.book, seen: this.seen, gone: this.tomb, from: 'server', name: '서버' })); } catch (e) {} return; } // 게임을 시작한 뒤 장부를 다시 달라고 한다 (제목 화면에서 받은 건 버려지므로)
    if (this.kind === 'ch') {
      if (m.t === 'lbid') { if (typeof m.key === 'string' && typeof m.bid === 'number') { const b = this.book[m.key] = this.book[m.key] || {}; b[s.id] = { name: s.name, bid: m.bid, at: this.now() }; this.dirty = true; } this.broadcast(m, s); return; }
      if (m.t === 'lbook') { // 클라이언트의 장부: 본인 것만 믿는다. 순위표는 최신 것으로
        for (const key in m.book || {}) { const e = m.book[key] && m.book[key][s.id]; if (e && typeof e.bid === 'number') { const b = this.book[key] = this.book[key] || {}; if (!b[s.id]) { b[s.id] = { name: s.name, bid: e.bid, at: this.now() }; this.dirty = true; } } }
        const mine = m.seen && m.seen[s.name]; if (mine) this.touchSeen(s.name, mine.cash, mine.pnl, mine.as, mine.earn);
        return;
      }
      if (m.t === 'forget') { // v178: 기록을 지우거나 파산한 사람은 순위표에서 뺀다 (이름은 서버가 보증하는 s.name만)
        if (s.name) { const at = this.now(); delete this.seen[s.name]; this.tomb[s.name] = at; this.dirty = true; this.broadcast({ t: 'forget', who: s.name, at, from: 'server', name: '서버' }, s); }
        return;
      }
      if (m.t === 'mdig') { // 굴 한 칸(또는 끊긴 동안 판 칸들)을 뚫었다: 새 칸만 저장하고 다른 사람에게 알린다
        const add = []; if (Array.isArray(m.c)) for (const k of m.c.slice(0, 600)) { if (typeof k !== 'string' || !/^-?\d{1,3},-?\d{1,3}$/.test(k) || this.mcells.has(k) || this.mcells.size >= MINE_MAX) continue; const [x, y] = k.split(',').map(Number); if (Math.abs(x) > MINE_LIM || Math.abs(y) > MINE_LIM) continue; this.mcells.add(k); add.push(k); }
        const l = Array.isArray(m.l) && m.l.length === 3 && m.l.every(n => Number.isInteger(n) && Math.abs(n) <= MINE_LIM) ? m.l : null; if (l) this.mlast = l;
        if (add.length || l) { this.mdirty = true; this.dirty = true; this.broadcast({ t: 'mdig', c: add, l, from: s.id, name: s.name }, s); }
        return;
      }
      if (m.t === 'getmine') { try { s.send(JSON.stringify({ t: 'mine', c: [...this.mcells], l: this.mlast, from: 'server', name: '서버' })); } catch (e) {} return; }
      if (m.t === 'pos') { if (typeof m.cs === 'number') this.touchSeen(s.name, m.cs, undefined, undefined, m.ea); else if (typeof m.pn === 'number') this.touchSeen(s.name, undefined, m.pn, undefined, m.ea); }
      if (m.t === 'asset') this.touchSeen(s.name, undefined, undefined, m.list); // 자산 요약: 자리 비운 사람 것도 순위 창에서 보이게 순위표에 같이 둔다
    }
    this.broadcast(m, s);
  }
  touchSeen(name, cash, pnl, as, earn) { // earn = 경매 차익 + 월세 누적 (순위 점수, v113)
    if (!name) return; if (this.tomb && this.tomb[name] && this.now() - this.tomb[name] < 15000) return; /* 지운 직전에 오던 위치 신호로 되살아나지 않게 */ const hasAs = Array.isArray(as); if (typeof cash !== 'number' && typeof pnl !== 'number' && typeof earn !== 'number' && !hasAs) return;
    const e = this.seen[name] || {}; if (typeof cash === 'number') e.cash = cash; if (typeof pnl === 'number') e.pnl = pnl; if (typeof earn === 'number') e.earn = earn; if (hasAs) e.as = as.slice(0, 10); e.at = this.now(); this.seen[name] = e; this.dirty = true;
  }
  async close(s) { await this.load(); this.broadcast({ t: 'players', list: this.players(s), from: 'server', name: '서버' }, s); /* 닫히는 소켓은 목록에서 빼고 보낸다: 나가면 접속 수가 바로 준다 (v79) */ if (this.kind === 'room' && s.id === this.hostId) this.broadcast({ t: 'hostgone', from: 'server', name: '서버' }); }
  // 10초마다: 심장박동(손님이 서버 생사를 안다) + 순위표 나눠 주기 + 오래된 것 정리 + 저장
  async tick() {
    await this.load();
    const t = this.now(); let n = 0;
    for (const key in this.book) { for (const id in this.book[key]) if (t - (this.book[key][id].at || 0) > BOOK_KEEP_MS) { delete this.book[key][id]; this.dirty = true; } if (!Object.keys(this.book[key]).length) { delete this.book[key]; this.dirty = true; } }
    for (const nm in this.tomb) if (t - this.tomb[nm] > SEEN_KEEP_MS) { delete this.tomb[nm]; this.dirty = true; }
    const names = Object.keys(this.seen); for (const nm of names) if (t - (this.seen[nm].at || 0) > SEEN_KEEP_MS) { delete this.seen[nm]; this.dirty = true; }
    if (names.length > SEEN_MAX) { for (const nm of names.sort((a, b) => (this.seen[a].at || 0) - (this.seen[b].at || 0)).slice(0, names.length - SEEN_MAX)) delete this.seen[nm]; this.dirty = true; }
    for (const s of this.sockets()) n++;
    if (n) { this.broadcast({ t: 'ping', from: 'server', name: '서버' }); if (this.kind === 'ch') this.broadcast({ t: 'lbook', book: {}, seen: this.seen, gone: this.tomb, from: 'server', name: '서버' }); }
    await this.persist();
    return n;
  }
}
