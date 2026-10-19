'use strict';
/* エンジンだけを使って、人間2人（ランダム操作）＋CPU1人で時間を進めながら数ゲーム回す。
   状態は毎ステップ JSON に通し、保存・復元で壊れないことも確かめる。 */
const assert = require('assert');
const { Engine, newState } = require('./engine');

function run(mode, games, drawPlay) {
  const seats = [{ uid: 'a', name: 'A' }, { uid: 'b', name: 'B' }, { name: 'CPU', cpu: true }];
  let now = 1_000_000;
  let St = newState(seats, { mode, games, hand: 5, jokers: 2, speed: 'fast', drawPlay });
  new Engine(St, now).newRound();
  let steps = 0;
  const store = () => { St = JSON.parse(JSON.stringify(St)); };
  while (steps++ < 20000) {
    store();
    const e = new Engine(St, now);
    if (St.phase === 'final') break;
    if (St.phase === 'result') {
      const host = true;
      if (St.total && St.round >= St.total) e.act(0, { t: 'final' }, host); else e.act(0, { t: 'next' }, host);
      continue;
    }
    // 人間の操作（ランダム）
    for (const me of [0, 1]) {
      const p = St.players[me];
      if (St.phase === 'return' && St.dobon.target === me) { e.act(me, { t: 'ret', v: Math.random() < .5 }, me === 0); continue; }
      if (St.phase !== 'play') continue;
      const w = St.win;
      if (w && w.by !== me && e.canDobon(me, w) && Math.random() < .8) e.act(me, { t: 'dobon' }, me === 0);
      if (St.phase === 'play' && St.turn === me && Math.random() < .5) {
        const opts = p.hand.filter(c => e.playable(c, me));
        if (opts.length && Math.random() < .8) e.act(me, { t: 'play', id: opts[0].id, suit: 'H' }, me === 0); else e.act(me, { t: 'draw' }, me === 0);
      }
    }
    // 時間を進めてジョブを実行
    const na = e.nextAt();
    now = na == null ? now + 200 : Math.max(now, na);
    e.runDue(now);
    // 不変条件: カード総数
    const total = St.deck.length + St.pile.length + St.players.reduce((s, p) => s + p.hand.length, 0);
    assert.strictEqual(total, 52 + 2, 'card count');
    // 公開ビューに手札が含まれない
    const pv = JSON.stringify(new Engine(St, now).publicView());
    if (St.phase !== 'result' && St.phase !== 'final') assert(!pv.includes('"hand"'), 'public leak');
  }
  assert.strictEqual(St.phase, 'final', 'did not finish (' + mode + ')');
  return St.players.map(p => p.score);
}
for (const [m, dp] of [['local', false], ['local', true], ['general', false]]) console.log(m, dp, 'OK', run(m, 3, dp));
// 山札が空になっても落ちない
console.log('engine tests passed');
