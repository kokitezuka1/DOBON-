'use strict';
/* Firestore を最小のメモリ実装に差し替えて、callable `act` を実際に動かすテスト
   （ロビー → 開始 → tick で進行 → 手札が他人に漏れない → 離席 → 終了まで） */
const assert = require('assert');
const Module = require('module');
const docs = new Map();
const ref = p => ({ path: p });
const fakeDb = {
  doc: p => ref(p),
  collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
  runTransaction: async fn => fn({
    get: async r => ({ exists: docs.has(r.path), data: () => JSON.parse(JSON.stringify(docs.get(r.path))) }),
    set: (r, d) => docs.set(r.path, JSON.parse(JSON.stringify(d))),
    update: (r, d) => docs.set(r.path, { ...docs.get(r.path), ...JSON.parse(JSON.stringify(d)) }),
    delete: r => docs.delete(r.path)
  })
};
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'firebase-admin/app') return { initializeApp() {} };
  if (req === 'firebase-admin/firestore') return { getFirestore: () => fakeDb };
  return origLoad.call(this, req, ...a);
};
const { act } = require('./index.js');
const call = (uid, data) => act.run({ auth: { uid }, data });
const room = c => docs.get('rooms/' + c);

(async () => {
  const { room: code } = await call('u1', { t: 'create', name: 'A' });
  await call('u2', { t: 'join', room: code, name: 'B' });
  await assert.rejects(call('u3', { t: 'settings', room: code, mode: 'general' }), /メンバー/);
  await assert.rejects(call('u2', { t: 'settings', room: code, mode: 'general' }), /ホスト/);
  await call('u1', { t: 'settings', room: code, mode: 'local', games: 1, speed: 'fast', hand: 5, jokers: 2 });
  await call('u1', { t: 'addcpu', room: code });
  assert.strictEqual(room(code).seats.length, 3);
  assert.deepStrictEqual(await call('u2', { t: 'start', room: code }), { ok: false });   // ホスト以外は開始できない
  await call('u1', { t: 'start', room: code });
  assert.strictEqual(room(code).status, 'game');
  await assert.rejects(call('u4', { t: 'join', room: code, name: 'D' }), /対戦中/);

  const pub = () => JSON.parse(room(code).pub);
  const hand = uid => JSON.parse(docs.get(`rooms/${code}/hands/${uid}`).cards);
  assert(!room(code).pub.includes('"hand"'), '公開状態に手札が入っている');
  assert.strictEqual(hand('u1').length, 5);
  // 他人の手札ドキュメントは自分のuid名でしか作られない
  assert(!docs.has(`rooms/${code}/hands/u3`));

  // 進行: 人間はランダム操作、時間は本当に待たずに nextAt の時点を now として tick
  const realNow = Date.now; let fake = realNow();
  Date.now = () => fake;
  let guard = 0;
  while (room(code).status === 'game' && pub().phase !== 'final' && guard++ < 6000) {
    const p = pub();
    if (p.phase === 'result') { await call('u1', { t: 'final', room: code }); continue; }
    if (p.phase === 'return') {
      const tgt = p.dobon.target; const uid = ['u1', 'u2', null][tgt];
      if (uid) { await call(uid, { t: 'ret', room: code, v: false }); continue; }
    }
    if (p.phase === 'play' && p.turn < 2) {
      const uid = ['u1', 'u2'][p.turn]; const h = hand(uid);
      const r = await call(uid, { t: 'play', room: code, id: h[0].id, suit: 'S' });
      if (!r.ok) await call(uid, { t: 'draw', room: code });
      continue;
    }
    fake = Math.max(fake, p.nextAt || fake) + 1;
    await call('u1', { t: 'tick', room: code });
  }
  assert.strictEqual(pub().phase, 'final', 'did not reach final (guard ' + guard + ')');
  const rows = pub().result.rows;
  assert(rows.length === 3);
  // 同じ手を繰り返さない: ホスト以外のfinal/nextは無効
  assert.deepStrictEqual(await call('u2', { t: 'again', room: code }), { ok: false });
  await call('u1', { t: 'again', room: code });
  assert.strictEqual(pub().round, 1);
  // 離席: u2が抜けるとCPUが代打
  await call('u2', { t: 'leave', room: code });
  assert(JSON.parse(docs.get(`rooms/${code}/priv/state`).json).players[1].away);
  await call('u1', { t: 'tolobby', room: code });
  assert.strictEqual(room(code).status, 'lobby');
  assert.strictEqual(room(code).seats.length, 2);   // u2 は外れ、u1 + CPU
  Date.now = realNow;
  console.log('index tests passed (ticks:', guard, ')');
})().catch(e => { console.error(e); process.exit(1); });
