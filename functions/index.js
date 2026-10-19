'use strict';
/* ドボン オンライン対戦：Cloud Functions（審判）。
   クライアントは Firestore を直接書けない。操作はすべて callable `act` を通り、
   ここで検証 → エンジンを進める → 公開状態(rooms/{code}.pub)と各人の手札(rooms/{code}/hands/{uid})を書く。
   ドボンの早押しは Firestore トランザクションの勝者が先着になる。 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Engine, newState } = require('./engine');

initializeApp();
const db = getFirestore();
const REGION = 'asia-northeast1';
setGlobalOptions({ region: REGION, maxInstances: 10 });

const DEFAULT_SETTINGS = { mode: 'local', games: 5, hand: 5, jokers: 2, speed: 'normal', drawPlay: false };
const pick = (v, list, d) => list.includes(v) ? v : d;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const fail = (code, msg) => { throw new HttpsError(code, msg); };

const roomRef = code => db.doc(`rooms/${code}`);
const privRef = code => db.doc(`rooms/${code}/priv/state`);
const handRef = (code, uid) => db.doc(`rooms/${code}/hands/${uid}`);

function saveGame(tx, code, room, E, now) {
  const v = (room.v || 0) + 1;
  const pub = E.publicView(); pub.now = now;
  tx.update(roomRef(code), { pub: JSON.stringify(pub), v, status: 'game', updatedAt: now, seats: room.seats, hostUid: room.hostUid });
  tx.set(privRef(code), { json: JSON.stringify(E.G) });
  E.G.players.forEach(p => { if (p.uid) tx.set(handRef(code, p.uid), { v, cards: JSON.stringify(p.hand) }); });
  return v;
}
function saveLobby(tx, code, room, now) {
  tx.update(roomRef(code), { status: 'lobby', pub: null, seats: room.seats, S: room.S, hostUid: room.hostUid, v: (room.v || 0) + 1, updatedAt: now });
}

exports.act = onCall({ cors: true, timeoutSeconds: 30 }, async req => {
  if (!req.auth) fail('unauthenticated', 'ログインが必要です');
  const uid = req.auth.uid;
  const m = req.data || {};
  const t = String(m.t || '');

  if (t === 'create') {
    const name = clean(m.name, 10) || '名無し';
    for (let k = 0; k < 8; k++) {
      const code = newCode();
      const ok = await db.runTransaction(async tx => {
        const s = await tx.get(roomRef(code));
        if (s.exists) return false;
        const now = Date.now();
        tx.set(roomRef(code), { code, status: 'lobby', hostUid: uid, S: { ...DEFAULT_SETTINGS }, seats: [{ uid, name, cpu: false }], pub: null, v: 1, createdAt: now, updatedAt: now });
        return true;
      });
      if (ok) return { room: code };
    }
    fail('resource-exhausted', '部屋を作れませんでした。もう一度お試しください');
  }

  const code = clean(m.room, 4).toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) fail('invalid-argument', '部屋コードが正しくありません');

  return db.runTransaction(async tx => {
    const rs = await tx.get(roomRef(code));
    if (!rs.exists) fail('not-found', 'その部屋はありません');
    const room = rs.data();
    const now = Date.now();
    const me = room.seats.findIndex(s => s.uid === uid);
    const isHost = room.hostUid === uid;
    const inGame = room.status === 'game';

    /* ---- 入室・退室 ---- */
    if (t === 'join') {
      if (me >= 0) {
        if (inGame) {
          const ps = await tx.get(privRef(code)); const St = JSON.parse(ps.data().json);
          const i = St.players.findIndex(p => p.uid === uid);
          if (i >= 0 && St.players[i].away) { St.players[i].away = false; const E = new Engine(St, now); saveGame(tx, code, room, E, now); }
        }
        return { room: code };
      }
      if (inGame) fail('failed-precondition', 'その部屋はもう対戦中です');
      if (room.seats.length >= 6) fail('failed-precondition', 'その部屋は満員です');
      room.seats.push({ uid, name: clean(m.name, 10) || '名無し', cpu: false });
      saveLobby(tx, code, room, now);
      return { room: code };
    }
    if (me < 0) fail('permission-denied', 'この部屋のメンバーではありません');

    if (t === 'leave') {
      if (inGame) {
        const ps = await tx.get(privRef(code)); const St = JSON.parse(ps.data().json);
        const i = St.players.findIndex(p => p.uid === uid);
        if (i >= 0) St.players[i].away = true;
        if (isHost) { const nh = room.seats.find(s => !s.cpu && s.uid !== uid && !St.players.find(p => p.uid === s.uid && p.away)); if (nh) room.hostUid = nh.uid; }
        const E = new Engine(St, now);
        if (St.phase === 'play' && E.auto(St.turn)) E.job('cpu', 1500, { turnId: St.turnId });
        saveGame(tx, code, room, E, now);
      } else {
        room.seats.splice(me, 1);
        if (!room.seats.some(s => !s.cpu)) { tx.delete(roomRef(code)); return { ok: true }; }
        if (isHost) room.hostUid = room.seats.find(s => !s.cpu).uid;
        saveLobby(tx, code, room, now);
      }
      return { ok: true };
    }

    /* ---- ロビー ---- */
    if (!inGame) {
      switch (t) {
        case 'settings': {
          if (!isHost) fail('permission-denied', 'ホストだけが変更できます');
          const S = room.S;
          S.mode = pick(m.mode, ['local', 'general'], S.mode);
          S.games = pick(+m.games, [1, 3, 5, 10, 0], S.games);
          S.hand = pick(+m.hand, [5, 7], S.hand);
          S.jokers = pick(+m.jokers, [0, 1, 2], S.jokers);
          S.speed = pick(m.speed, ['slow', 'normal', 'fast'], S.speed);
          S.drawPlay = !!m.drawPlay;
          saveLobby(tx, code, room, now); return { ok: true };
        }
        case 'addcpu': {
          if (!isHost || room.seats.length >= 6) return { ok: false };
          const n = room.seats.filter(s => s.cpu).length + 1;
          room.seats.push({ uid: null, name: 'CPU ' + n, cpu: true });
          saveLobby(tx, code, room, now); return { ok: true };
        }
        case 'delcpu': {
          if (!isHost) return { ok: false };
          for (let i = room.seats.length - 1; i >= 0; i--) if (room.seats[i].cpu) { room.seats.splice(i, 1); break; }
          saveLobby(tx, code, room, now); return { ok: true };
        }
        case 'start': {
          if (!isHost || room.seats.length < 2) return { ok: false };
          const St = newState(room.seats, room.S);
          const E = new Engine(St, now); E.newRound();
          saveGame(tx, code, room, E, now); return { ok: true };
        }
      }
      return { ok: false };
    }

    /* ---- 対戦中 ---- */
    const ps = await tx.get(privRef(code));
    const St = JSON.parse(ps.data().json);
    const E = new Engine(St, now);
    const seatNo = St.players.findIndex(p => p.uid === uid);

    if (t === 'tolobby') {
      if (!isHost) return { ok: false };
      room.seats = room.seats.filter(s => s.cpu || !St.players.find(p => p.uid === s.uid && p.away));
      saveLobby(tx, code, room, now); return { ok: true };
    }
    if (t === 'again') {
      if (!isHost || St.phase !== 'final') return { ok: false };
      const St2 = newState(room.seats, room.S);
      const E2 = new Engine(St2, now); E2.newRound();
      saveGame(tx, code, room, E2, now); return { ok: true };
    }
    if (t === 'tick') {
      const na = E.nextAt();
      if (na == null) return { ok: false, retryMs: null };
      if (na > now) return { ok: false, retryMs: na - now };
      E.runDue(now);
      saveGame(tx, code, room, E, now);
      return { ok: true };
    }
    if (seatNo < 0) fail('permission-denied', 'この対戦の参加者ではありません');
    const before = St.evSeq;
    const ok = E.act(seatNo, m, isHost);
    if (ok || St.evSeq !== before) saveGame(tx, code, room, E, now);
    return { ok };
  });
});

/* 24時間動きのない部屋を片付ける */
exports.cleanup = onSchedule({ schedule: 'every 24 hours', timeZone: 'Asia/Tokyo' }, async () => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const snap = await db.collection('rooms').where('updatedAt', '<', cutoff).limit(200).get();
  for (const d of snap.docs) await db.recursiveDelete(d.ref);
});
