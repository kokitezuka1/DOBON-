'use strict';
/* ドボン オンライン対戦サーバー。
   状態はすべてサーバーが持ち、クライアントには自分の手札だけを含む「見え方」を送る。
   ドボンの早押しはサーバーに届いた順で決まる（w.claimed）。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8094;
const HOST = process.env.HOST || '127.0.0.1';
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, '..'));
const MAX_ROOMS = 40;
const RETURN_TIMEOUT = 30000;

const SUITS = ['S', 'H', 'D', 'C'];
const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SNAME = { S: 'スペード', H: 'ハート', D: 'ダイヤ', C: 'クラブ' };
const RL = r => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[r] || String(r));
const SPEED = { slow: 2300, normal: 1500, fast: 850 };
const CLAIM = { slow: 1.4, normal: 1, fast: .6 };
const RULES = {
  local: { name: 'ローカル', fx: { 1: 'follow', 2: 'plus', 3: 'skip', 8: 'suit', 9: 'rev' }, plus: 'mul', outWin: true },
  general: { name: '一般', fx: { 1: 'skip', 2: 'plus', 8: 'suit', 11: 'rev' }, plus: 'add', outWin: false }
};
const rand = (a, b) => a + Math.random() * (b - a);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (v, list, d) => list.includes(v) ? v : d;

const DEFAULT_SETTINGS = { mode: 'local', games: 5, hand: 5, jokers: 2, speed: 'normal', drawPlay: false };

/* ---------- ゲームエンジン（1部屋ぶん） ---------- */
class Game {
  constructor(room) {
    this.room = room;
    this.S = room.S;
    this.gen = 0;
    this.winSeq = 0;
    const seats = room.seats;
    this.G = {
      players: seats.map(s => ({ name: s.name, cpu: s.cpu, seat: s, score: 0, hand: [] })),
      mode: this.S.mode, R: RULES[this.S.mode], round: 0, total: this.S.games,
      starter: Math.floor(Math.random() * seats.length), turnId: 0, phase: 'play'
    };
    this.newRound();
  }
  get N() { return this.G.players.length; }
  auto(i) { const p = this.G.players[i]; return p.cpu || p.seat.away; }
  later(fn, ms) { const g = this.gen; const t = setTimeout(() => { if (g === this.gen && (this.room.game === this || !this.room.game)) { try { fn(); } catch (e) { console.error(e); } } }, ms); room_timers(this.room).add(t); }
  render() { this.room.broadcastState(this); }
  toast(text, cls = '', seat = null) { this.room.send({ t: 'toast', text, cls }, seat); }
  flash(text, sub) { this.room.send({ t: 'flash', text, sub }); }

  dobonVal(c) { return c.joker ? 0 : c.rank; }
  dobonSum(h) { return h.reduce((s, c) => s + this.dobonVal(c), 0); }
  pointVal(c) { return this.G.mode === 'general' ? (c.joker ? 50 : c.rank) : (c.joker ? 100 : c.rank === 8 ? 50 : c.rank >= 10 ? 10 : c.rank); }
  handScore(cards) {
    const base = cards.reduce((s, c) => s + this.pointVal(c), 0);
    if (this.G.mode === 'general') return { base, n2: 0, pts: base };
    const n2 = cards.filter(c => !c.joker && c.rank === 2).length;
    return { base, n2, pts: base * 2 ** n2 };
  }
  fxOf(c) { return c.joker ? null : this.G.R.fx[c.rank]; }
  label(c) { return c.joker ? 'ジョーカー' : SYM[c.suit] + RL(c.rank); }
  log(t) { const G = this.G; G.log.unshift(t); G.log.length = Math.min(G.log.length, 4); }
  step(i, k) { const G = this.G; for (let t = 0; t < k; t++) i = (i + G.dir + this.N) % this.N; return i; }

  newRound() {
    const G = this.G, S = this.S;
    this.gen++;
    G.round++;
    let id = 0; const deck = [];
    for (const s of SUITS) for (let r = 1; r <= 13; r++) deck.push({ id: id++, suit: s, rank: r, joker: false });
    for (let j = 0; j < S.jokers; j++) deck.push({ id: id++, suit: null, rank: 0, joker: true });
    shuffle(deck);
    G.players.forEach(p => p.hand = []);
    for (let k = 0; k < S.hand; k++) G.players.forEach(p => p.hand.push(deck.pop()));
    let top = deck.pop();
    while (top.joker) { deck.unshift(top); top = deck.pop(); }
    G.deck = deck; G.pile = [{ ...top, by: -1 }];
    G.eff = { suit: top.suit, rank: top.rank };
    G.dir = 1; G.pending = 0; G.forced = null; G.win = null; G.drew = false; G.drawnId = null;
    G.dobon = null; G.result = null;
    G.turn = G.starter; G.starter = (G.starter + 1) % this.N;
    G.log = [`第${G.round}ゲーム開始 — 最初の場札 ${this.label(top)}`];
    this.startTurn();
  }

  startTurn() {
    const G = this.G;
    G.drew = false; G.drawnId = null; G.turnId++;
    G.phase = 'play';
    if (this.auto(G.turn)) { const id = G.turnId; this.later(() => { if (G.turnId === id) this.cpuTurn(); }, SPEED[this.S.speed]); }
    this.render();
  }

  basicPlayable(c) { const e = this.G.eff; return c.joker || c.suit === e.suit || c.rank === e.rank; }
  playable(c, pi) {
    const G = this.G;
    if (!G.R.outWin && G.players[pi].hand.length === 1) return false;
    if (G.pending > 0) return !c.joker && c.rank === 2;
    if (G.forced && G.forced.player === pi) return c.joker || c.suit === G.forced.suit;
    if (G.drew) return c.id === G.drawnId && this.basicPlayable(c);
    return this.basicPlayable(c);
  }

  drawCards(pi, k) {
    const G = this.G; const got = [];
    for (let t = 0; t < k; t++) {
      if (!G.deck.length) {
        if (G.pile.length <= 1) break;
        const top = G.pile.pop();
        G.deck = shuffle(G.pile.map(({ by, ...c }) => c)); G.pile = [top];
        this.log('山札がなくなったので場札を混ぜ直した');
      }
      const c = G.deck.pop(); G.players[pi].hand.push(c); got.push(c);
    }
    if (got.length < k) this.toast('山札も場札も足りず、これ以上引けない', 'miss');
    return got;
  }

  closeWindow() {
    const G = this.G, w = G.win; if (!w) return;
    if (!w.claimed) w.eligible.forEach(i => this.toast(`${G.players[i].name}はドボンを逃した！（${this.label(w.card)}）`, 'miss'));
    G.win = null;
  }
  canDobon(i, w) {
    if (!w || i === w.by) return false;
    const h = this.G.players[i].hand; return h.length > 0 && this.dobonSum(h) === w.value;
  }
  refreshEligibility() {
    const G = this.G, w = G.win; if (!w || w.claimed) return;
    G.players.forEach((p, i) => {
      if (i === w.by || w.eligible.has(i)) return;
      if (this.canDobon(i, w)) {
        w.eligible.add(i);
        if (this.auto(i) && Math.random() < 0.85) {
          const wid = w.id;
          this.later(() => { if (G.win && G.win.id === wid && !G.win.claimed && this.canDobon(i, G.win)) this.declareDobon(i); }, rand(650, 1600) * CLAIM[this.S.speed]);
        }
      }
    });
  }

  playCard(pi, id, suit) {
    const G = this.G, p = G.players[pi]; const idx = p.hand.findIndex(c => c.id === id);
    if (idx < 0) return;
    const c = p.hand.splice(idx, 1)[0];
    this.closeWindow();
    G.pile.push({ ...c, by: pi });
    G.win = { card: c, by: pi, value: this.dobonVal(c), eligible: new Set(), claimed: false, id: ++this.winSeq };
    G.forced = null;
    let skip = 1, stay = false, note = '';
    if (!c.joker) {
      G.eff = { suit: c.suit, rank: c.rank };
      switch (this.fxOf(c)) {
        case 'follow': G.forced = { player: pi, suit: c.suit }; stay = true; note = ' → 同じ柄をもう1枚'; break;
        case 'plus': G.pending = G.pending ? (G.R.plus === 'mul' ? G.pending * 2 : G.pending + 2) : 2; note = ` → 次の人 +${G.pending}`; break;
        case 'skip': skip = 2; note = this.N === 2 ? ' → スキップ（もう一度）' : ' → 次の人スキップ'; break;
        case 'suit': G.eff.suit = suit; note = ` → ${SYM[suit]}${SNAME[suit]}を指定`; break;
        case 'rev': if (this.N > 2) { G.dir *= -1; note = ' → リバース'; } else note = '（2人なので効果なし）'; break;
      }
    } else note = ' → 前のカードに続ける';
    this.log(`${p.name}：${this.label(c)}${note}`);
    if (p.hand.length === 0 && !stay) { this.endRound({ type: 'out', winner: pi }); return; }
    this.refreshEligibility();
    if (stay) {
      G.drew = false; G.drawnId = null; this.render();
      if (this.auto(pi)) { const tid = G.turnId; this.later(() => { if (G.turnId === tid) this.cpuTurn(); }, SPEED[this.S.speed] * .6); }
      return;
    }
    G.turn = this.step(pi, skip); this.startTurn();
  }

  drawAction(pi) {
    const G = this.G, p = G.players[pi];
    if (G.pending > 0) {
      const k = G.pending; this.drawCards(pi, k); G.pending = 0; this.log(`${p.name}：${k}枚引いた`);
      this.refreshEligibility(); G.turn = this.step(pi, 1); this.startTurn(); return;
    }
    if (G.forced && G.forced.player === pi) {
      this.drawCards(pi, 1); G.forced = null; this.log(`${p.name}：同じ柄が出せず1枚引いた`);
      this.refreshEligibility(); G.turn = this.step(pi, 1); this.startTurn(); return;
    }
    if (G.drew) { this.log(`${p.name}：パス`); G.turn = this.step(pi, 1); this.startTurn(); return; }
    const got = this.drawCards(pi, 1); this.log(`${p.name}：1枚引いた`);
    this.refreshEligibility();
    if (this.S.drawPlay && got[0] && this.basicPlayable(got[0])) {
      G.drew = true; G.drawnId = got[0].id; this.render();
      if (this.auto(pi)) { const tid = G.turnId; this.later(() => { if (G.turnId === tid) this.cpuTurn(); }, SPEED[this.S.speed] * .6); }
      return;
    }
    G.turn = this.step(pi, 1); this.startTurn();
  }

  cpuTurn() {
    const G = this.G;
    if (G.phase !== 'play') return;
    const pi = G.turn, p = G.players[pi]; if (!this.auto(pi)) return;
    const opts = p.hand.filter(c => this.playable(c, pi));
    if (!opts.length) { this.drawAction(pi); return; }
    let best = null, bs = -1e9;
    for (const c of opts) {
      let s = this.pointVal(c);
      if (c.joker) s = (opts.length === 1 || p.hand.length <= 2) ? 60 : -40;
      else if (this.fxOf(c) === 'follow') s += p.hand.some(x => x !== c && !x.joker && x.suit === c.suit) ? 6 : -25;
      else if (this.fxOf(c) === 'plus') s += 8;
      else if (this.fxOf(c) === 'skip' || this.fxOf(c) === 'rev') s += 3;
      s += Math.random() * 5;
      if (s > bs) { bs = s; best = c; }
    }
    let suit;
    if (this.fxOf(best) === 'suit') {
      const cnt = { S: 0, H: 0, D: 0, C: 0 };
      p.hand.forEach(c => { if (c !== best && !c.joker) cnt[c.suit]++; });
      suit = SUITS.reduce((a, b) => cnt[b] > cnt[a] ? b : a, SUITS[Math.floor(Math.random() * 4)]);
    }
    this.playCard(pi, best.id, suit);
  }

  declareDobon(di) {
    const G = this.G;
    if (G.phase !== 'play') return;
    const w = G.win, d = G.players[di];
    if (!this.canDobon(di, w)) { this.toast(`${d.name}：ドボン不成立`, 'bad', di); return; }
    w.claimed = true; this.gen++;
    G.dobon = { by: di, target: w.by, value: w.value, card: w.card };
    this.log(`${d.name}がドボン！（${this.label(w.card)}）`);
    this.flash('ドボン！', d.name);
    const t = G.players[w.by];
    if (this.auto(w.by)) {
      G.phase = 'wait'; this.render();
      this.later(() => this.resolveReturn(this.dobonSum(t.hand) === w.value), 1500);
    } else {
      G.phase = 'return'; this.render();
      this.later(() => { if (G.phase === 'return') { G.phase = 'wait'; this.resolveReturn(false); } }, RETURN_TIMEOUT);
    }
  }
  resolveReturn(tryIt) {
    const G = this.G; const { by, target, value } = G.dobon; const t = G.players[target];
    if (tryIt) {
      if (t.hand.length && this.dobonSum(t.hand) === value) {
        this.flash('ドボン返し！', t.name); this.gen++;
        this.later(() => this.endRound({ type: 'dobon', winner: target, loser: by, returned: true, value }), 1100);
        G.phase = 'wait'; this.render(); return;
      }
      this.toast(`${t.name}：ドボン返し不成立`, 'bad');
    }
    this.endRound({ type: 'dobon', winner: by, loser: target, returned: false, value });
  }

  endRound(r) {
    const G = this.G;
    this.gen++; G.phase = 'result';
    const winHand = G.players[r.winner].hand.slice();
    const rows = G.players.map((p, i) => {
      let cards = p.hand.slice(), recv = false;
      if (G.mode === 'local' && r.type === 'dobon' && i === r.loser) { cards = cards.concat(winHand); recv = true; }
      const sc = i === r.winner ? { base: 0, n2: 0, pts: 0 } : this.handScore(cards);
      if (G.mode === 'general' && r.type === 'dobon' && i === r.loser) { sc.dbl = true; sc.pts *= 2; }
      p.score += sc.pts;
      return { i, cards, recv, ...sc };
    });
    G.result = { ...r, rows };
    this.render();
  }

  /* ---------- クライアントからの操作 ---------- */
  act(seat, m) {
    const G = this.G; const me = G.players.findIndex(p => p.seat === seat);
    if (me < 0) return;
    const mine = G.turn === me && G.phase === 'play';
    switch (m.t) {
      case 'play': {
        if (!mine) return;
        const c = G.players[me].hand.find(x => x.id === m.id);
        if (!c || !this.playable(c, me)) return;
        let suit;
        if (this.fxOf(c) === 'suit') { suit = m.suit; if (!SUITS.includes(suit)) return; }
        this.playCard(me, c.id, suit); break;
      }
      case 'draw': if (mine) this.drawAction(me); break;
      case 'dobon': this.declareDobon(me); break;
      case 'ret':
        if (G.phase === 'return' && G.dobon.target === me) { G.phase = 'wait'; this.resolveReturn(!!m.v); }
        break;
      case 'next': if (G.phase === 'result' && seat.host && !(G.total && G.round >= G.total)) this.newRound(); break;
      case 'final': if (G.phase === 'result' && seat.host) { G.phase = 'final'; this.render(); } break;
    }
  }
  seatChanged() {
    // 離席した人の番なら、CPUが代わりに動く
    const G = this.G;
    if (G.phase === 'play' && this.auto(G.turn)) { const id = G.turnId; this.later(() => { if (G.turnId === id) this.cpuTurn(); }, SPEED[this.S.speed]); }
    if (G.phase === 'return' && this.auto(G.dobon.target)) { G.phase = 'wait'; this.later(() => this.resolveReturn(this.dobonSum(G.players[G.dobon.target].hand) === G.dobon.value), 1500); }
    this.refreshEligibility();
    this.render();
  }

  /* 自分の手札だけを含む「見え方」 */
  view(me) {
    const G = this.G;
    const show = G.phase === 'result' || G.phase === 'final';
    return {
      me, mode: G.mode, R: G.R, round: G.round, total: G.total,
      players: G.players.map((p, i) => ({
        name: p.name + (p.seat.away && !p.cpu ? '（離席）' : ''), cpu: p.cpu, score: p.score,
        hand: i === me || (show && G.result) ? p.hand : p.hand.map(() => ({ back: true }))
      })),
      deck: { length: G.deck.length }, pile: G.pile.slice(-2),
      eff: G.eff, dir: G.dir, pending: G.pending, forced: G.forced, drew: G.drew, drawnId: G.drawnId,
      turn: G.turn, phase: G.phase, log: G.log, dobon: G.dobon, result: G.result,
      host: G.players.findIndex(p => p.seat.host)
    };
  }
}
const timerSets = new WeakMap();
function room_timers(room) { let s = timerSets.get(room); if (!s) { s = new Set(); timerSets.set(room, s); } return s; }

/* ---------- 部屋 ---------- */
const rooms = new Map();
const newCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c)); return c; };
const newToken = () => require('crypto').randomBytes(12).toString('hex');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

class Room {
  constructor(code) { this.code = code; this.seats = []; this.S = { ...DEFAULT_SETTINGS }; this.game = null; this.idleSince = Date.now(); }
  humans() { return this.seats.filter(s => !s.cpu); }
  online() { return this.humans().filter(s => s.ws && !s.away); }
  send(msg, seat = null) {
    const data = JSON.stringify(msg);
    if (seat != null) { const s = this.game ? this.game.G.players[seat].seat : this.seats[seat]; if (s && s.ws && s.ws.readyState === 1) s.ws.send(data); return; }
    for (const s of this.seats) if (s.ws && s.ws.readyState === 1) s.ws.send(data);
  }
  broadcastState(game) {
    const G = game.G;
    G.players.forEach((p, i) => { const s = p.seat; if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'state', view: game.view(i) })); });
  }
  broadcastLobby() {
    this.seats.forEach(s => {
      if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({
        t: 'lobby', room: this.code, S: this.S, canStart: this.seats.length >= 2,
        members: this.seats.map(m => ({ name: m.name, cpu: m.cpu, host: m.host, away: !!m.away, me: m === s }))
      }));
    });
  }
  stopGame() {
    if (this.game) { this.game.gen++; const g = this.game; this.game = null; for (const t of room_timers(this)) clearTimeout(t); room_timers(this).clear(); void g; }
  }
}

function leaveSeat(room, seat, hard) {
  if (room.game && !hard) {
    seat.ws = null; seat.away = true;
    if (seat.host) { const nh = room.seats.find(s => !s.cpu && s.ws && !s.away); if (nh) { seat.host = false; nh.host = true; } }
    room.game.seatChanged();
  } else {
    room.seats = room.seats.filter(s => s !== seat);
    if (room.game) { room.stopGame(); }
    if (seat.host) { const nh = room.seats.find(s => !s.cpu); if (nh) nh.host = true; }
    room.broadcastLobby();
  }
  if (!room.humans().length || room.seats.every(s => s.cpu || !s.ws)) room.idleSince = Date.now();
}

/* ---------- HTTP / WebSocket ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok rooms=' + rooms.size); return; }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (p !== '/index.html') { res.writeHead(404); res.end('not found'); return; }   // 配るのは index.html だけ
  fs.readFile(path.join(WEB_DIR, 'index.html'), (err, buf) => {
    if (err) { res.writeHead(500); res.end('error'); return; }
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(buf);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

wss.on('connection', ws => {
  let room = null, seat = null;
  let bucket = 30, last = Date.now();
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  const err = msg => ws.send(JSON.stringify({ t: 'err', msg }));

  ws.on('message', raw => {
    const now = Date.now(); bucket = Math.min(30, bucket + (now - last) / 100); last = now;   // 1秒に約10通まで
    if (--bucket < 0) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (seat) return;
      const name = clean(m.name, 10) || '名無し';
      const code = clean(m.room, 4).toUpperCase();
      if (code) {
        const r = rooms.get(code);
        if (!r) return err('その部屋はありません');
        const back = m.token && r.seats.find(s => s.token === m.token && !s.cpu);
        if (back) {
          if (back.ws && back.ws !== ws) { try { back.ws.close(); } catch {} }
          room = r; seat = back; seat.ws = ws; seat.away = false;
        } else {
          if (r.game) return err('その部屋はもう対戦中です');
          if (r.seats.length >= 6) return err('その部屋は満員です');
          room = r; seat = { name, cpu: false, host: false, token: newToken(), ws, away: false }; r.seats.push(seat);
        }
      } else {
        if (rooms.size >= MAX_ROOMS) return err('部屋がいっぱいです。あとでもう一度');
        room = new Room(newCode()); rooms.set(room.code, room);
        seat = { name, cpu: false, host: true, token: newToken(), ws, away: false }; room.seats.push(seat);
      }
      ws.send(JSON.stringify({ t: 'hello', room: room.code, token: seat.token }));
      room.idleSince = null;
      if (room.game) { room.game.seatChanged(); } else room.broadcastLobby();
      return;
    }
    if (!room || !seat) return;

    if (room.game) {
      if (m.t === 'leave') { leaveSeat(room, seat, false); ws.close(); return; }
      if (m.t === 'tolobby' && seat.host) { room.stopGame(); room.seats.forEach(s => { if (!s.cpu && s.away) s.away = false; }); room.seats = room.seats.filter(s => s.cpu || s.ws); room.broadcastLobby(); return; }
      if (m.t === 'again' && seat.host && room.game.G.phase === 'final') { const n = room.seats.slice(); room.stopGame(); room.seats = n; room.game = new Game(room); return; }
      room.game.act(seat, m);
      return;
    }
    // ロビー
    switch (m.t) {
      case 'leave': leaveSeat(room, seat, true); ws.close(); break;
      case 'settings': {
        if (!seat.host) return;
        const S = room.S;
        S.mode = pick(m.mode, ['local', 'general'], S.mode);
        S.games = pick(+m.games, [1, 3, 5, 10, 0], S.games);
        S.hand = pick(+m.hand, [5, 7], S.hand);
        S.jokers = pick(+m.jokers, [0, 1, 2], S.jokers);
        S.speed = pick(m.speed, ['slow', 'normal', 'fast'], S.speed);
        S.drawPlay = !!m.drawPlay;
        room.broadcastLobby(); break;
      }
      case 'addcpu': {
        if (!seat.host || room.seats.length >= 6) return;
        const n = room.seats.filter(s => s.cpu).length + 1;
        room.seats.push({ name: 'CPU ' + n, cpu: true, host: false, token: null, ws: null, away: false });
        room.broadcastLobby(); break;
      }
      case 'delcpu': {
        if (!seat.host) return;
        const i = room.seats.map(s => s.cpu).lastIndexOf(true);
        if (i >= 0) room.seats.splice(i, 1);
        room.broadcastLobby(); break;
      }
      case 'start':
        if (!seat.host || room.seats.length < 2) return;
        room.game = new Game(room); break;
    }
  });
  ws.on('close', () => { if (room && seat && seat.ws === ws) leaveSeat(room, seat, false); });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.seats.every(s => s.cpu || !s.ws)) {
      if (!r.idleSince) r.idleSince = now;
      if (now - r.idleSince > 30 * 60 * 1000) { r.stopGame(); rooms.delete(code); }
    }
  }
}, 30000).unref();

if (require.main === module) server.listen(PORT, HOST, () => console.log(`dobon-server http://${HOST}:${PORT}`));
module.exports = { server, wss, rooms, Game, Room };
