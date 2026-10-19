'use strict';
/* 人間2人（ランダムに操作）＋CPU1人で数ゲームを最後まで回すスモークテスト */
process.env.PORT = 0;
const WebSocket = require('ws');
const { server } = require('./server.js');
const assert = require('assert');
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const mk = name => new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, name, view: null, lobby: null, room: null, results: 0, finals: 0 };
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.t === 'hello') c.room = m.room;
      if (m.t === 'lobby') c.lobby = m;
      if (m.t === 'state') { c.view = m.view; act(c); }
      if (m.t === 'err') console.log(name, 'err', m.msg);
    });
    ws.on('open', () => res(c));
  });
  const send = (c, o) => c.ws.send(JSON.stringify(o));
  const act = c => {
    const v = c.view, me = v.me;
    // 他人の手札が漏れていないこと
    v.players.forEach((p, i) => { if (i !== me && v.phase !== 'result' && v.phase !== 'final') assert(p.hand.every(x => x.back && x.rank === undefined), 'hand leak'); });
    assert(!('deck' in v) || v.deck.cards === undefined);
    if (v.phase === 'result') {
      if (v.host === me) setTimeout(() => send(c, v.total && v.round >= v.total ? { t: 'final' } : { t: 'next' }), 10);
      return;
    }
    if (v.phase === 'final') { c.finals++; return; }
    if (v.phase === 'return' && v.dobon.target === me) { send(c, { t: 'ret', v: Math.random() < .5 }); return; }
    if (v.phase !== 'play') return;
    // ドボンを狙う
    const sum = v.players[me].hand.reduce((s, x) => s + (x.joker ? 0 : x.rank), 0);
    if (v.pile.length && v.pile[v.pile.length - 1].by !== me && v.pile[v.pile.length - 1].by >= 0 && sum === (v.pile[v.pile.length - 1].joker ? 0 : v.pile[v.pile.length - 1].rank)) send(c, { t: 'dobon' });
    if (v.turn !== me) return;
    const h = v.players[me].hand;
    const c0 = h[Math.floor(Math.random() * h.length)];
    setTimeout(() => {
      if (Math.random() < .7) send(c, { t: 'play', id: c0.id, suit: 'S' });
      send(c, { t: 'draw' });
    }, 5);
  };
  const a = await mk('A'); send(a, { t: 'join', name: 'A' });
  await new Promise(r => setTimeout(r, 100));
  const b = await mk('B'); send(b, { t: 'join', name: 'B', room: a.room });
  await new Promise(r => setTimeout(r, 100));
  send(a, { t: 'addcpu' });
  send(a, { t: 'settings', mode: 'local', games: 3, hand: 5, jokers: 2, speed: 'fast', drawPlay: false });
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(a.lobby.members.length, 3);
  send(a, { t: 'start' });
  const t0 = Date.now();
  while (!(a.finals && b.finals) && Date.now() - t0 < 120000) await new Promise(r => setTimeout(r, 200));
  if(!(a.finals&&b.finals)){console.log(JSON.stringify({ph:a.view.phase,turn:a.view.turn,me:a.view.me,pend:a.view.pending,forced:a.view.forced,round:a.view.round,log:a.view.log,hands:a.view.players.map(p=>p.hand.length)}));}
  assert(a.finals && b.finals, 'game did not finish');
  const sc = a.view.players.map(p => p.score);
  console.log('OK final scores', sc, 'rounds', a.view.round);
  process.exit(0);
});
