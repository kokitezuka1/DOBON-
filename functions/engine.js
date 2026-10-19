'use strict';
/* ドボンのゲームエンジン（純粋なロジック。Firebaseにもテストにも依存しない）。
   状態 St は JSON で保存できる素のオブジェクト。タイマーは St.jobs に「いつ・何を」を書き、
   クライアントが nextAt に合わせて tick を呼ぶとサーバーが期限切れのジョブを実行する。 */

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
const RETURN_TIMEOUT = 30000;
const IDLE_TIMEOUT = 90000;
const rand = (a, b) => a + Math.random() * (b - a);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* seats: [{uid,name,cpu,host}] */
function newState(seats, S) {
  return {
    S, mode: S.mode, R: RULES[S.mode], round: 0, total: S.games, turnId: 0, phase: 'play', gen: 0, winSeq: 0, evSeq: 0,
    starter: Math.floor(Math.random() * seats.length),
    players: seats.map(s => ({ uid: s.uid || null, name: s.name, cpu: !!s.cpu, away: false, score: 0, hand: [] })),
    jobs: [], events: [], log: [], deck: [], pile: [], eff: null, dir: 1, pending: 0, forced: null, win: null,
    drew: false, drawnId: null, dobon: null, result: null
  };
}

class Engine {
  constructor(St, now) { this.G = St; this.S = St.S; this.now = now; }
  get N() { return this.G.players.length; }
  auto(i) { const p = this.G.players[i]; return p.cpu || p.away; }

  /* ---- ジョブ（旧 later） ---- */
  job(kind, ms, data = {}) { this.G.jobs.push({ at: this.now + Math.round(ms), kind, gen: this.G.gen, ...data }); }
  runDue(now) {
    const G = this.G; let n = 0;
    while (n++ < 30) {
      const due = G.jobs.filter(j => j.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      G.jobs.splice(G.jobs.indexOf(due), 1);
      if (due.gen !== G.gen) continue;
      this.now = now;
      this.exec(due);
    }
    this.prune();
    return n > 1;
  }
  prune() { this.G.jobs = this.G.jobs.filter(j => j.gen === this.G.gen); }
  nextAt() { const j = this.G.jobs.filter(x => x.gen === this.G.gen).map(x => x.at); return j.length ? Math.min(...j) : null; }
  exec(j) {
    const G = this.G;
    switch (j.kind) {
      case 'cpu': if (G.turnId === j.turnId) this.cpuTurn(); break;
      case 'idle': {
        if (G.turnId === j.turnId && G.phase === 'play' && !this.auto(G.turn)) { G.players[G.turn].away = true; this.event(`${G.players[G.turn].name}は離席中（CPUが代わりに出します）`, 'miss'); this.cpuTurn(); }
        break;
      }
      case 'claim': if (G.win && G.win.id === j.wid && !G.win.claimed && this.canDobon(j.i, G.win)) this.declareDobon(j.i); break;
      case 'resolve': this.resolveReturn(!!j.tryIt); break;
      case 'retTimeout': if (G.phase === 'return') { G.phase = 'wait'; this.resolveReturn(false); } break;
      case 'end': this.endRound(j.r); break;
    }
  }
  event(text, cls = '', to = null) { const G = this.G; G.events.push({ id: ++G.evSeq, text, cls, to }); G.events = G.events.slice(-8); }
  flash(text, sub) { const G = this.G; G.events.push({ id: ++G.evSeq, flash: true, text, sub }); G.events = G.events.slice(-8); }

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
    G.gen++; G.jobs = [];
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
    if (this.auto(G.turn)) this.job('cpu', SPEED[this.S.speed], { turnId: G.turnId });
    else this.job('idle', IDLE_TIMEOUT, { turnId: G.turnId });
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
    if (got.length < k) this.event('山札も場札も足りず、これ以上引けない', 'miss');
    return got;
  }

  closeWindow() {
    const G = this.G, w = G.win; if (!w) return;
    if (!w.claimed) w.eligible.forEach(i => this.event(`${G.players[i].name}はドボンを逃した！（${this.label(w.card)}）`, 'miss'));
    G.win = null;
  }
  canDobon(i, w) {
    if (!w || i === w.by) return false;
    const h = this.G.players[i].hand; return h.length > 0 && this.dobonSum(h) === w.value;
  }
  refreshEligibility() {
    const G = this.G, w = G.win; if (!w || w.claimed) return;
    G.players.forEach((p, i) => {
      if (i === w.by || w.eligible.includes(i)) return;
      if (this.canDobon(i, w)) {
        w.eligible.push(i);
        if (this.auto(i) && Math.random() < 0.85) this.job('claim', rand(650, 1600) * CLAIM[this.S.speed], { i, wid: w.id });
      }
    });
  }

  playCard(pi, id, suit) {
    const G = this.G, p = G.players[pi]; const idx = p.hand.findIndex(c => c.id === id);
    if (idx < 0) return;
    const c = p.hand.splice(idx, 1)[0];
    this.closeWindow();
    G.pile.push({ ...c, by: pi });
    G.win = { card: c, by: pi, value: this.dobonVal(c), eligible: [], claimed: false, id: ++G.winSeq };
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
      G.drew = false; G.drawnId = null;
      if (this.auto(pi)) this.job('cpu', SPEED[this.S.speed] * .6, { turnId: G.turnId });
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
      G.drew = true; G.drawnId = got[0].id;
      if (this.auto(pi)) this.job('cpu', SPEED[this.S.speed] * .6, { turnId: G.turnId });
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
    if (G.phase !== 'play') return false;
    const w = G.win, d = G.players[di];
    if (!this.canDobon(di, w)) { this.event(`${d.name}：ドボン不成立`, 'bad', di); return false; }
    w.claimed = true; G.gen++; G.jobs = [];
    G.dobon = { by: di, target: w.by, value: w.value, card: w.card };
    this.log(`${d.name}がドボン！（${this.label(w.card)}）`);
    this.flash('ドボン！', d.name);
    const t = G.players[w.by];
    if (this.auto(w.by)) {
      G.phase = 'wait';
      this.job('resolve', 1500, { tryIt: this.dobonSum(t.hand) === w.value });
    } else {
      G.phase = 'return';
      this.job('retTimeout', RETURN_TIMEOUT);
    }
    return true;
  }
  resolveReturn(tryIt) {
    const G = this.G; const { by, target, value } = G.dobon; const t = G.players[target];
    if (tryIt) {
      if (t.hand.length && this.dobonSum(t.hand) === value) {
        this.flash('ドボン返し！', t.name); G.gen++; G.jobs = [];
        G.phase = 'wait';
        this.job('end', 1100, { r: { type: 'dobon', winner: target, loser: by, returned: true, value } });
        return;
      }
      this.event(`${t.name}：ドボン返し不成立`, 'bad');
    }
    this.endRound({ type: 'dobon', winner: by, loser: target, returned: false, value });
  }

  endRound(r) {
    const G = this.G;
    G.gen++; G.jobs = []; G.phase = 'result';
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
  }

  /* プレイヤー seat 番号 me からの操作。成功したら true */
  act(me, m, isHost) {
    const G = this.G;
    const wasAway = G.players[me].away;
    const mine = G.turn === me && G.phase === 'play';
    let ok = false;
    switch (m.t) {
      case 'play': {
        if (!mine) break;
        const c = G.players[me].hand.find(x => x.id === m.id);
        if (!c || !this.playable(c, me)) break;
        let suit;
        if (this.fxOf(c) === 'suit') { suit = m.suit; if (!SUITS.includes(suit)) break; }
        if (wasAway) G.players[me].away = false;
        this.playCard(me, c.id, suit); ok = true; break;
      }
      case 'draw': if (mine) { if (wasAway) G.players[me].away = false; this.drawAction(me); ok = true; } break;
      case 'dobon': if (wasAway) G.players[me].away = false; ok = this.declareDobon(me); break;
      case 'ret':
        if (G.phase === 'return' && G.dobon.target === me) { G.phase = 'wait'; this.resolveReturn(!!m.v); ok = true; }
        break;
      case 'next': if (G.phase === 'result' && isHost && !(G.total && G.round >= G.total)) { this.newRound(); ok = true; } break;
      case 'final': if (G.phase === 'result' && isHost) { G.phase = 'final'; ok = true; } break;
    }
    if (ok && wasAway && G.players[me].away) G.players[me].away = false;
    return ok;
  }

  /* 全員に見せてよい状態（手札は枚数だけ） */
  publicView() {
    const G = this.G;
    return {
      mode: G.mode, R: G.R, round: G.round, total: G.total,
      players: G.players.map(p => ({ name: p.name + (p.away && !p.cpu ? '（離席）' : ''), cpu: p.cpu, score: p.score, count: p.hand.length })),
      deck: { length: G.deck.length }, pile: G.pile.slice(-2),
      eff: G.eff, dir: G.dir, pending: G.pending, forced: G.forced, drew: G.drew, drawnId: G.drawnId,
      turn: G.turn, phase: G.phase, log: G.log, dobon: G.dobon, result: G.result,
      nextAt: this.nextAt(), now: this.now, events: G.events
    };
  }
}

module.exports = { Engine, newState, RULES, SUITS };
