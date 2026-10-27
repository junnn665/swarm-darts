/* SWARM DARTS — みんなで対戦（Firebase Realtime Database）
 *
 * データの置き場所: rooms/darts-<4ケタ>
 *   game: "darts", created, host, level, seed, state: "lobby" | "playing", round, startAt
 *   players/<pid>: name, joined, online, round, status: "run" | "done", score, count, avg, live
 *     live: { x, y, z, c, ph, t }   ← 走っている最中の位置と本数（ゴースト表示用）
 *   ev/<id>: from, name, type: "ojama" | "stamp", s, round, t
 */

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyARjb_t0hEpQKM_6Wmbzl_H7z-e7rMcKjY',
  authDomain: 'odeko-ddb38.firebaseapp.com',
  databaseURL: 'https://odeko-ddb38-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'odeko-ddb38',
  storageBucket: 'odeko-ddb38.firebasestorage.app',
  messagingSenderId: '310865503380',
  appId: '1:310865503380:web:fb1c2b173cb6fbee70c081',
};
const FIREBASE_VER = '10.12.2';
const KEY = (c) => `rooms/darts-${c}`;
const ROOM_TTL = 24 * 60 * 60 * 1000;
const LIVE_EVERY = 250;
const START_DELAY = 4000;
export const LEVELS = [
  { v: 2, name: 'かんたん' },
  { v: 4, name: 'ふつう' },
  { v: 7, name: 'むずかしい' },
  { v: 11, name: '鬼' },
];
const levelName = (v) => (LEVELS.find((l) => l.v === v) || LEVELS[1]).name;
const COLORS = ['#ff3d7f', '#3fa9ff', '#ffd23d', '#2fe0b0', '#b06cff', '#ff8a3d', '#9aff5a', '#ff7ad9'];
const STAMPS = ['👍', '😂', '😱', '🔥', 'ナイス', 'まだまだ'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無視 */ } },
};

export function initNet(api) {
  const PID = window.PID_OVERRIDE || (() => {
    let p = ls.get('sd_pid');
    if (!p) { p = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); ls.set('sd_pid', p); }
    return p;
  })();
  // 同じサイトのほかのゲームで入れた名前があれば使う
  const myName = () => ls.get('sd_name') || ls.get('pref_name') || ls.get('odeko_name') || '';
  const saveName = (v) => ls.set('sd_name', v);

  // ---------- 通信 ----------
  let NET = null, netPromise = null, connected = true;

  function loadScript(src) {
    return new Promise((ok, ng) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = ng;
      document.head.appendChild(s);
    });
  }

  function firebaseNet() {
    const fb = window.firebase;
    fb.initializeApp(FIREBASE_CONFIG);
    const db = fb.database();
    let offset = 0;
    db.ref('.info/serverTimeOffset').on('value', (s) => { offset = s.val() || 0; });
    return {
      on(path, cb) { const r = db.ref(path), h = (s) => cb(s.val()); r.on('value', h); return () => r.off('value', h); },
      get(path) { return db.ref(path).once('value').then((s) => s.val()); },
      set(path, v) { return db.ref(path).set(v); },
      update(path, v) { return db.ref(path).update(v); },
      tx(path, fn) { return db.ref(path).transaction(fn).then((r) => ({ committed: r.committed, val: r.snapshot.val() })); },
      now() { return Date.now() + offset; },
      onConnected(cb) { db.ref('.info/connected').on('value', (s) => cb(!!s.val())); },
      onDisconnectSet(path, v) { return db.ref(path).onDisconnect().set(v); },
      cancelDisconnect(path) { return db.ref(path).onDisconnect().cancel(); },
      // 古くなった対戦部屋（darts- で始まるもの）だけを消す
      cleanOld(cutoff) {
        return db.ref('rooms').orderByChild('created').endAt(cutoff).limitToFirst(30).once('value').then((snap) => {
          const jobs = [];
          snap.forEach((c) => { const v = c.val(); if (String(c.key).startsWith('darts-') && v && v.created <= cutoff) jobs.push(c.ref.remove()); });
          return Promise.all(jobs);
        });
      },
    };
  }

  function ensureNet() {
    if (NET) return Promise.resolve(true);
    if (window.NET_OVERRIDE) { NET = window.NET_OVERRIDE; return Promise.resolve(true); } // テスト用
    if (!netPromise) {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VER}/`;
      const timeout = new Promise((_, ng) => setTimeout(() => ng(new Error('timeout')), 10000));
      netPromise = Promise.race([loadScript(base + 'firebase-app-compat.js').then(() => loadScript(base + 'firebase-database-compat.js')), timeout])
        .then(() => {
          NET = firebaseNet();
          NET.onConnected((ok) => {
            connected = ok;
            $('mpConn').classList.toggle('hidden', ok || !code);
            if (ok && code) NET.update(`${KEY(code)}/players/${PID}`, { online: true }).catch(() => {});
          });
          return true;
        })
        .catch(() => { netPromise = null; return false; });
    }
    return netPromise;
  }

  function netError(e) {
    console.warn(e);
    const m = String((e && (e.code || e.message)) || e);
    if (/permission/i.test(m)) return 'データベースに書きこめませんでした（Firebase のルール設定を確認してね）';
    return '通信できませんでした。電波のよい所でもう一度ためしてね';
  }

  // ---------- 画面 ----------
  const SCREENS = ['mpCreate', 'mpJoin', 'mpLobby', 'mpResult'];
  let screen = null;
  function show(id) {
    screen = id;
    SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
    if (id) api.showHome(false);
  }
  function msg(id, text, info) {
    const el = $(id);
    el.textContent = text || '';
    el.classList.toggle('info', !!info);
  }

  // ---------- 状態 ----------
  let code = null, R = null, unsub = null;
  let myRound = -1, finished = false, liveTimer = null, wonPlayed = -1;
  const seenEv = new Set();
  let createLevel = 4;

  const me = () => (R && R.players && R.players[PID]) || null;
  const isHost = () => !!R && R.host === PID;
  const inviteUrl = () => `${location.origin}${location.pathname}?room=${code}`;
  const online = (p) => p && p.online !== false;
  const participants = () => Object.entries((R && R.players) || {})
    .filter(([, p]) => p && p.round === R.round)
    .map(([id, p]) => ({ id, ...p }));
  function colorOf(id) {
    const ids = Object.entries((R && R.players) || {}).sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0)).map(([k]) => k);
    const i = ids.indexOf(id);
    return COLORS[(i < 0 ? 0 : i) % COLORS.length];
  }

  // ---------- 部屋を作る / 参加 ----------
  function segButtons(el, cur, onPick, enabled = true) {
    el.innerHTML = LEVELS.map((l) => `<button data-v="${l.v}" class="${l.v === cur ? 'on' : ''}" ${enabled ? '' : 'disabled'}>${l.name}</button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('button[data-v]');
      if (b && enabled) onPick(Number(b.dataset.v));
    };
  }

  function openCreate() {
    $('mpNameC').value = myName();
    msg('mpCreateMsg', '');
    const draw = () => segButtons($('mpLevelSegC'), createLevel, (v) => { createLevel = v; draw(); });
    draw();
    show('mpCreate');
    ensureNet();
  }
  function openJoin(c) {
    $('mpCode').value = c || '';
    $('mpNameJ').value = myName();
    msg('mpJoinMsg', '');
    show('mpJoin');
    ensureNet();
  }

  function cleanName(v) { return String(v || '').trim().slice(0, 10); }

  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  $('btnMpCreate').addEventListener('click', openCreate);
  $('btnMpJoin').addEventListener('click', () => openJoin(''));
  document.querySelectorAll('[data-mpback]').forEach((b) => b.addEventListener('click', () => { show(null); api.toHome(); }));
  $('mpCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });

  $('mpCreateGo').addEventListener('click', () => busy($('mpCreateGo'), async () => {
    const name = cleanName($('mpNameC').value);
    if (!name) return msg('mpCreateMsg', 'なまえを入れてね');
    saveName(name);
    msg('mpCreateMsg', 'つないでいます…', true);
    if (!(await ensureNet())) return msg('mpCreateMsg', netError('net'));
    try {
      const now = NET.now();
      if (NET.cleanOld) NET.cleanOld(now - ROOM_TTL).catch(() => {});
      for (let i = 0; i < 12; i++) {
        const c = String(1000 + Math.floor(Math.random() * 9000));
        const room = {
          game: 'darts', created: now, host: PID, level: createLevel, seed: 0, state: 'lobby', round: 0,
          players: { [PID]: { name, joined: now, online: true, round: -1 } },
        };
        const r = await NET.tx(KEY(c), (cur) => (cur && cur.created > now - ROOM_TTL ? undefined : room));
        if (r.committed) { enter(c); return; }
      }
      msg('mpCreateMsg', '部屋がいっぱいでした。もう一度ためしてね');
    } catch (e) { msg('mpCreateMsg', netError(e)); }
  }));

  $('mpJoinGo').addEventListener('click', () => busy($('mpJoinGo'), async () => {
    const c = $('mpCode').value;
    const name = cleanName($('mpNameJ').value);
    if (!/^\d{4}$/.test(c)) return msg('mpJoinMsg', '4ケタの部屋番号を入れてね');
    if (!name) return msg('mpJoinMsg', 'なまえを入れてね');
    saveName(name);
    msg('mpJoinMsg', 'つないでいます…', true);
    if (!(await ensureNet())) return msg('mpJoinMsg', netError('net'));
    try {
      const room = await NET.get(KEY(c));
      if (!room || room.game !== 'darts') return msg('mpJoinMsg', 'その番号の部屋が見つかりません');
      const ex = room.players && room.players[PID];
      await NET.update(`${KEY(c)}/players/${PID}`, { name, joined: (ex && ex.joined) || NET.now(), online: true, round: ex ? ex.round : -1 });
      enter(c);
    } catch (e) { msg('mpJoinMsg', netError(e)); }
  }));

  function enter(c) {
    code = c;
    R = null;
    myRound = -1;
    finished = false;
    seenEv.clear();
    try { history.replaceState(null, '', `${location.pathname}?room=${c}`); } catch { /* 無視 */ }
    NET.onDisconnectSet(`${KEY(c)}/players/${PID}/online`, false);
    unsub = NET.on(KEY(c), onRoom);
    msg('mpLobbyMsg', '');
    show('mpLobby');
  }

  function leave() {
    if (!code) return;
    const upd = { [`players/${PID}/online`]: false, [`players/${PID}/live`]: null };
    if (isHost()) {
      const next = Object.entries(R.players || {}).filter(([id, p]) => id !== PID && online(p)).sort((a, b) => a[1].joined - b[1].joined)[0];
      if (next) upd.host = next[0];
    }
    NET.update(KEY(code), upd).catch(() => {});
    NET.cancelDisconnect(`${KEY(code)}/players/${PID}/online`);
    if (unsub) unsub();
    unsub = null; code = null; R = null; myRound = -1; finished = false;
    stopLive();
    $('mpConn').classList.add('hidden');
    try { history.replaceState(null, '', location.pathname); } catch { /* 無視 */ }
    api.exitVersus();
    show(null);
    api.toHome();
  }
  $('mpLeave').addEventListener('click', leave);
  $('mpLeave2').addEventListener('click', leave);

  // ---------- 部屋の更新 ----------
  function onRoom(v) {
    if (!code) return;
    if (!v) {
      const c = code;
      code = 'x'; leave();
      api.notice(`部屋 ${c} はなくなりました`);
      return;
    }
    const first = !R;
    R = v;
    if (first) Object.keys(v.ev || {}).forEach((id) => seenEv.add(id));
    if (!me()) {
      // 自分が消えていたら入り直す
      NET.update(`${KEY(code)}/players/${PID}`, { name: myName() || 'ゲスト', joined: NET.now(), online: true, round: -1 }).catch(() => {});
      return;
    }
    hostCheck();

    for (const [id, e] of Object.entries(v.ev || {})) {
      if (seenEv.has(id)) continue;
      seenEv.add(id);
      if (!e || e.from === PID || e.round !== R.round) continue;
      if (e.type === 'ojama') api.ojama(e.name, colorOf(e.from));
      else if (e.type === 'stamp') api.stamp(e.name, e.s, colorOf(e.from));
    }

    const inRound = R.state === 'playing' && me().round === R.round;
    if (inRound && myRound !== R.round) {
      myRound = R.round;
      finished = false;
      show(null);
      api.startVersus({ seed: R.seed, level: R.level, startAt: R.startAt, now: () => NET.now(), levelName: levelName(R.level) });
      startLive();
    }

    if (R.state === 'lobby' || !inRound) {
      if (screen !== 'mpLobby') {
        stopLive();
        if (myRound !== -1) api.exitVersus();
        myRound = -1;
        finished = false;
        show('mpLobby');
      }
      renderLobby();
    } else {
      updateGhosts();
      if (finished) renderResult();
    }
  }

  function hostCheck() {
    const h = R.players[R.host];
    if (online(h)) return;
    const c = Object.entries(R.players).filter(([, p]) => online(p)).sort((a, b) => a[1].joined - b[1].joined)[0];
    if (c && c[0] === PID) NET.update(KEY(code), { host: PID }).catch(() => {});
  }

  // ---------- 待合室 ----------
  let qrFor = null;
  function renderLobby() {
    $('mpTiles').innerHTML = code.split('').map((d) => `<div class="tile">${d}</div>`).join('');
    if (qrFor !== code) {
      qrFor = code;
      try {
        const q = window.qrcode(0, 'M');
        q.addData(inviteUrl());
        q.make();
        $('mpQr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
      } catch { $('mpQr').innerHTML = ''; }
    }
    const canEdit = isHost() && R.state === 'lobby';
    segButtons($('mpLevelSeg'), R.level, (lv) => NET.update(KEY(code), { level: lv }).catch(() => {}), canEdit);
    const ps = Object.entries(R.players || {}).filter(([, p]) => online(p)).sort((a, b) => a[1].joined - b[1].joined);
    $('mpPlayers').innerHTML = ps.map(([id, p]) => `<li class="${id === PID ? 'me' : ''}"><span class="dot" style="background:${colorOf(id)}"></span><span class="nm">${esc(p.name)}</span>${id === R.host ? '<span class="tag">👑 ホスト</span>' : ''}${id === PID ? '<span class="tag">あなた</span>' : ''}</li>`).join('');
    $('mpCount').textContent = `${ps.length}人`;
    $('mpStart').classList.toggle('hidden', !canEdit);
    if (R.state === 'playing') msg('mpLobbyMsg', '対戦中です。次の回から参加できます', true);
    else if (!isHost()) msg('mpLobbyMsg', 'ホストのスタートを待っています…', true);
    else msg('mpLobbyMsg', ps.length < 2 ? '友だちに番号かQRを送ってね（ひとりでもスタートできます）' : '', true);
  }

  $('mpStart').addEventListener('click', () => busy($('mpStart'), async () => {
    if (!isHost()) return;
    const round = (R.round || 0) + 1;
    const upd = { state: 'playing', round, seed: (Math.random() * 2 ** 31) | 0, startAt: NET.now() + START_DELAY, ev: null };
    for (const [id, p] of Object.entries(R.players || {})) {
      if (!online(p)) continue;
      upd[`players/${id}/round`] = round;
      upd[`players/${id}/status`] = 'run';
      upd[`players/${id}/score`] = null;
      upd[`players/${id}/live`] = null;
    }
    try { await NET.update(KEY(code), upd); } catch (e) { msg('mpLobbyMsg', netError(e)); }
  }));
  $('mpAgain').addEventListener('click', () => { if (isHost()) { R.state = 'lobby'; $('mpStart').click(); } });
  $('mpToLobby').addEventListener('click', () => { if (isHost()) NET.update(KEY(code), { state: 'lobby' }).catch(() => {}); });

  $('mpCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteUrl()); msg('mpLobbyMsg', '招待リンクをコピーしました', true); }
    catch { msg('mpLobbyMsg', inviteUrl(), true); }
  });
  $('mpShareLink').addEventListener('click', async () => {
    const text = `SWARM DARTS で対戦しよう！ 部屋番号 ${code}`;
    if (navigator.share) { try { await navigator.share({ title: 'SWARM DARTS', text, url: inviteUrl() }); } catch { /* キャンセル */ } }
    else $('mpCopy').click();
  });

  // ---------- 対戦中 ----------
  function startLive() {
    stopLive();
    liveTimer = setInterval(() => {
      if (!code || !R) return;
      const L = api.live();
      if (L && !finished) NET.update(`${KEY(code)}/players/${PID}`, { live: { ...L, t: NET.now() } }).catch(() => {});
      renderRaceRank();
    }, LIVE_EVERY);
    $('raceRank').classList.remove('hidden');
    $('stampBar').classList.remove('hidden');
  }
  function stopLive() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    $('raceRank').classList.add('hidden');
    $('stampBar').classList.add('hidden');
    api.setGhosts([]);
  }

  function updateGhosts() {
    const list = participants()
      .filter((p) => p.id !== PID && online(p) && p.live && p.status !== 'done')
      .map((p) => ({ id: p.id, name: p.name, color: colorOf(p.id), ...p.live }));
    api.setGhosts(list);
  }

  function renderRaceRank() {
    if (!R || finished) return;
    const mine = api.live();
    const rows = participants().map((p) => {
      const isMe = p.id === PID;
      const c = isMe ? (mine ? mine.c : 0) : p.status === 'done' ? null : (p.live ? p.live.c : 0);
      return { ...p, isMe, c };
    });
    rows.sort((a, b) => (b.status === 'done' ? b.score : b.c) - (a.status === 'done' ? a.score : a.c));
    $('raceRank').innerHTML = rows.map((p, i) => `<li class="${p.isMe ? 'me' : ''}"><span class="dot" style="background:${colorOf(p.id)}"></span><span class="nm">${i + 1}. ${esc(p.name)}</span><b>${p.status === 'done' && !p.isMe ? api.fmt(p.score) + '点' : api.fmt(p.c || 0)}</b></li>`).join('');
  }

  function sendEv(e) {
    if (!code || !R) return;
    const id = NET.now().toString(36) + Math.random().toString(36).slice(2, 6);
    NET.set(`${KEY(code)}/ev/${id}`, { ...e, from: PID, name: (me() && me().name) || '', round: R.round, t: NET.now() }).catch(() => {});
  }

  // スタンプ
  for (const [bar, cls] of [[$('stampBar'), ''], [$('mpStampsR'), '']]) {
    bar.innerHTML = STAMPS.map((s) => `<button class="${cls}" data-s="${esc(s)}">${esc(s)}</button>`).join('');
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-s]');
      if (!b) return;
      sendEv({ type: 'stamp', s: b.dataset.s });
      api.stamp((me() && me().name) || '', b.dataset.s, colorOf(PID));
    });
  }

  // ---------- 結果 ----------
  function renderResult() {
    const ps = participants();
    const done = (p) => p.status === 'done' || !online(p);
    const allDone = ps.every(done);
    const sorted = ps.slice().sort((a, b) => {
      if (done(a) !== done(b)) return done(a) ? -1 : 1;
      return (b.score || 0) - (a.score || 0);
    });
    let rank = 0, prev = null;
    const rows = sorted.map((p, i) => {
      if (done(p) && p.score !== prev) { rank = i + 1; prev = p.score; }
      p.rank = done(p) ? rank : null;
      return p;
    });
    const mine = rows.find((p) => p.id === PID);
    $('mpRank').innerHTML = rows.map((p) => {
      const st = p.status === 'done' ? `${api.fmt(p.score || 0)}点` : !online(p) ? '退出' : `プレイ中… ${api.fmt((p.live && p.live.c) || 0)}本`;
      const crown = allDone && p.rank === 1 ? '👑' : p.rank ? `${p.rank}` : '…';
      return `<li class="${p.id === PID ? 'me' : ''}"><span class="rk">${crown}</span><span class="dot" style="background:${colorOf(p.id)}"></span><span class="nm">${esc(p.name)}</span><span class="sc">${st}</span></li>`;
    }).join('');
    const title = $('mpResTitle');
    if (!allDone) { title.textContent = '集計中…'; title.className = ''; }
    else if (ps.length === 1) { title.textContent = 'おつかれさま！'; title.className = 'clear'; }
    else if (mine && mine.rank === 1) { title.textContent = '🏆 1位！ WINNER'; title.className = 'clear'; }
    else { title.textContent = `${mine ? mine.rank : '-'}位`; title.className = 'fail'; }
    $('mpResSub').textContent = `部屋 ${code} ・ ${levelName(R.level)}`;
    if (allDone && wonPlayed !== R.round) {
      wonPlayed = R.round;
      if (mine && mine.rank === 1 && ps.length > 1) api.sfx.win(); else api.sfx.lose();
    }
    const host = isHost();
    $('mpAgain').classList.toggle('hidden', !host || !allDone);
    $('mpToLobby').classList.toggle('hidden', !host || !allDone);
    msg('mpResMsg', !allDone ? 'みんなのゴールを待っています…' : host ? '' : 'ホストが次の対戦を始めるのを待っています…', true);
  }

  // ---------- ゲーム本体から呼ばれる ----------
  const hooks = {
    active: () => !!code,
    onGate(op) {
      // ×4 以上のゲートを通ると、相手にトゲのおじゃまが飛ぶ
      if (op.t === '×' && op.v >= 4) {
        sendEv({ type: 'ojama' });
        api.notice('💥 おじゃま発射！');
      }
    },
    finish(res) {
      if (!code || finished) return;
      finished = true;
      $('raceRank').classList.add('hidden');
      NET.update(`${KEY(code)}/players/${PID}`, { status: 'done', score: res.score, count: res.count, avg: res.avg, live: null }).catch(() => {});
      if (R && R.players && R.players[PID]) Object.assign(R.players[PID], { status: 'done', score: res.score });
      show('mpResult');
      renderResult();
    },
  };

  // 招待リンク（?room=1234）から来たとき
  const q = new URLSearchParams(location.search).get('room');
  if (q && /^\d{4}$/.test(q)) setTimeout(() => openJoin(q), 0);

  return hooks;
}
