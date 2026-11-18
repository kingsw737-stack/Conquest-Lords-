'use strict';
/* Arcane Warfare server: serves the game files and runs authoritative online matches (core.js) over WebSocket. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Core = require('./core.js');

const PORT = process.env.PORT || 3000;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/core.js': ['core.js', 'text/javascript; charset=utf-8'],
  '/maps.js': ['maps.js', 'text/javascript; charset=utf-8']
};
const MAPDIR = path.join(__dirname, 'maps');
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/health') { res.writeHead(200); return res.end('ok'); }
  let file, type;
  const m = /^\/maps\/([\w-]+\.webp)$/.exec(u);
  if (m) { file = path.join(MAPDIR, m[1]); type = 'image/webp'; }
  else { const f = STATIC[u]; if (f) { file = path.join(__dirname, f[0]); type = f[1]; } }
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(e.code === 'ENOENT' ? 404 : 500); return res.end(e.code === 'ENOENT' ? 'Not found' : 'Error'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': m ? 'public, max-age=3600' : 'no-cache' }); res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 8192 });

/* ---- Firebase sign-in check -------------------------------------------------------------
   Players sign in on the client with Firebase Auth and send their ID token in the 'hello' message.
   We verify it here (RS256 signature against Google's public certs, plus aud / iss / exp checks),
   so nobody can skip the login screen and talk to the WebSocket directly.
   Set FIREBASE_PROJECT_ID in Render (Environment tab). No firebase-admin package needed. */
const https = require('https');
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || '').trim();
if (!FIREBASE_PROJECT_ID) console.warn('WARNING: FIREBASE_PROJECT_ID is not set. Online play is disabled until you set it.');
const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certs = null, certsExp = 0;
const getCerts = () => new Promise((resolve, reject) => {
  if (certs && Date.now() < certsExp) return resolve(certs);
  https.get(CERT_URL, res => {
    let b = ''; res.on('data', d => b += d);
    res.on('end', () => {
      try {
        certs = JSON.parse(b);
        const mx = /max-age=(\d+)/.exec(res.headers['cache-control'] || '');
        certsExp = Date.now() + (mx ? +mx[1] : 3600) * 1000;
        resolve(certs);
      } catch (e) { reject(e); }
    });
  }).on('error', reject);
});
const b64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
/* the permanent, unique wizard name lives in Firestore at players/{uid}; read it with the player's own token (the rules allow that) */
const fetchPlayerName = (uid, idToken) => new Promise((resolve, reject) => {
  const req = https.get({
    host: 'firestore.googleapis.com', timeout: 5000, headers: { Authorization: 'Bearer ' + idToken },
    path: '/v1/projects/' + encodeURIComponent(FIREBASE_PROJECT_ID) + '/databases/(default)/documents/players/' + encodeURIComponent(uid)
  }, res => {
    let b = ''; res.on('data', d => b += d);
    res.on('end', () => {
      if (res.statusCode === 404) return resolve('');
      if (res.statusCode !== 200) return reject(new Error('profile lookup ' + res.statusCode));
      try { resolve(String(JSON.parse(b).fields.name.stringValue || '')); } catch (e) { reject(new Error('profile lookup parse')); }
    });
  });
  req.on('timeout', () => req.destroy(new Error('profile lookup timeout')));
  req.on('error', reject);
});
async function verifyFirebaseToken(token, getCertsFn = getCerts, projectId = FIREBASE_PROJECT_ID) {
  if (!projectId) throw new Error('auth not configured');
  if (typeof token !== 'string' || token.length > 4000) throw new Error('bad token');
  const parts = token.split('.'); if (parts.length !== 3) throw new Error('bad token');
  const header = JSON.parse(b64u(parts[0]).toString()), p = JSON.parse(b64u(parts[1]).toString());
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad alg');
  const pem = (await getCertsFn())[header.kid]; if (!pem) throw new Error('unknown key');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(crypto.createPublicKey(pem), b64u(parts[2]));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== projectId || p.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('wrong project');
  if (!(p.exp > now) || !(p.iat <= now + 60)) throw new Error('expired');
  if (!p.sub || typeof p.sub !== 'string') throw new Error('no subject');
  return p;
}
/* ------------------------------------------------------------------------------------------ */


const rooms = new Map(), names = new Map();
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => { for (; ;) { let c = ''; for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)]; if (!rooms.has(c)) return c; } };
const clean = n => String(n || '').replace(/[^\w \-.]/g, '').trim().slice(0, 14);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const GRACE = 30000, MAXN = 5;
/* Host-picked map: core picks the map from the seed (Core.mapFor), so find a seed that gives the chosen map.
   Returns null when the id is not a real map. Core.Game and the client need no change. */
const seedForMap = id => {
  if (typeof id !== 'string' || !id || id.length > 40) return null;
  for (let i = 0; i < 4000; i++) { const s = (Math.random() * 0xffffffff) >>> 0; try { if (Core.mapFor(s).id === id) return s; } catch (e) { return null; } }
  return null;
};
let lobbyDirty = true; const dirty = () => { lobbyDirty = true; };
const roomsMsg = () => ({
  t: 'rooms', list: [...rooms.values()].slice(0, 60).map(r => ({
    code: r.code, host: (r.players.find(p => p.id === r.hostId) || {}).name || '', n: r.n, locked: r.locked, phase: r.phase, a: r.team(0).length, b: r.team(1).length
  }))
});

/* A room holds two teams of up to n players (1v1 .. 5v5). Lobby phase -> game phase -> back to lobby phase. */
class Room {
  constructor(n, locked) {
    this.code = newCode(); this.n = n; this.locked = locked; this.players = []; this.hostId = 0; this.nid = 1;
    this.phase = 'lobby'; this.game = null; this.loop = null; this.order = []; this.map = '';   /* '' = random */
    rooms.set(this.code, this); dirty();
  }
  team(t) { return this.players.filter(p => p.team === t); }
  pickTeam(pref) {
    const c = [0, 1].sort((x, y) => this.team(x).length - this.team(y).length);
    if (pref === 0 || pref === 1) c.unshift(pref);
    return c.find(t => this.team(t).length < this.n);
  }
  by(ws) { return this.players.find(p => p.id === ws.pid); }
  add(ws, team) {
    const p = { id: this.nid++, ws, name: ws.name, token: crypto.randomBytes(8).toString('hex'), team, dc: null, idx: -1, out: false, gone: false };
    this.players.push(p); if (!this.hostId) this.hostId = p.id;
    ws.room = this; ws.pid = p.id; return p;
  }
  info(id) {
    return {
      t: 'room', code: this.code, n: this.n, locked: this.locked, host: this.hostId, phase: this.phase, you: id, map: this.map,
      teams: [0, 1].map(t => this.team(t).map(p => ({ id: p.id, name: p.name, away: !p.ws })))
    };
  }
  sync() { for (const p of this.players) send(p.ws, this.info(p.id)); dirty(); }
  destroy() { clearInterval(this.loop); for (const p of this.players) clearTimeout(p.dc); rooms.delete(this.code); dirty(); }
  /* lobby phase only: take a player out of the room */
  remove(p) {
    clearTimeout(p.dc); this.players = this.players.filter(x => x !== p);
    if (p.ws && p.ws.pid === p.id) p.ws.room = null;
    if (!this.players.length) return this.destroy();
    if (this.hostId === p.id) this.hostId = (this.players.find(x => x.ws) || this.players[0]).id;
    this.sync();
  }
  bcast(o) { const s = JSON.stringify(o); for (const p of this.players) if (p.ws && p.ws.readyState === 1) p.ws.send(s); }
  start(ws) {
    const p = this.by(ws), A = this.team(0), B = this.team(1);
    if (!p || p.id !== this.hostId || this.phase !== 'lobby') return;
    if (!A.length || A.length !== B.length) return send(ws, { t: 'err', msg: 'Both teams need the same number of players.' });
    /* alternate the teams in turn order: A1, B1, A2, B2 ... */
    this.order = []; for (let i = 0; i < A.length; i++) this.order.push(A[i], B[i]);
    this.order.forEach((q, i) => { q.idx = i; q.out = false; q.gone = false; });
    this.phase = 'game'; this.seed = (this.map && seedForMap(this.map)) ?? ((Math.random() * 0xffffffff) >>> 0);
    this.game = new Core.Game({ seed: this.seed, players: this.order.map(q => ({ name: q.name, team: q.team })) });
    for (const w of this.game.wiz) w.grounded = true;
    this.evBuf = []; this.order.forEach(q => this.sendStart(q));
    clearInterval(this.loop); this.last = Date.now(); this.acc = 0; this.snapT = 0;
    this.loop = setInterval(() => this.tick(), 16); this.sync();
  }
  sendStart(p) {
    send(p.ws, { t: 'start', code: this.code, token: p.token, idx: p.idx, seed: this.seed, map: this.map, names: this.order.map(x => x.name), teams: this.order.map(x => x.team), carves: this.game.carves });
  }
  tick() {
    const g = this.game, now = Date.now(); const dt = Math.min(.1, (now - this.last) / 1000); this.last = now;
    this.acc += dt; this.snapT += dt;
    while (this.acc >= 1 / 60) { g.step(1 / 60); this.acc -= 1 / 60; const ev = g.drain(); if (ev.length) this.evBuf.push(...ev); }
    if (this.evBuf.length) { this.bcast({ t: 'ev', e: this.evBuf }); this.evBuf = []; }
    if (this.snapT >= .05 || g.state === 'over') {
      this.snapT = 0; this.bcast(Object.assign({ t: 's' }, g.snap()));
      if (g.state === 'over') { clearInterval(this.loop); this.loop = null; this.finish(); }
    }
  }
  /* match is over: everybody who is still connected goes back to the room lobby */
  finish() {
    clearInterval(this.loop); this.loop = null; this.phase = 'lobby'; this.game = null;
    const stay = this.players.filter(p => p.ws && !p.gone);
    for (const p of this.players) { clearTimeout(p.dc); p.idx = -1; p.out = false; }
    this.players = stay;
    if (!stay.length) return this.destroy();
    if (!stay.some(p => p.id === this.hostId)) this.hostId = stay[0].id;
    this.sync();
  }
  /* socket closed */
  drop(ws) {
    const p = this.by(ws); if (!p || p.ws !== ws) return;
    if (this.phase === 'lobby') return this.remove(p);
    p.ws = null; clearTimeout(p.dc); p.dc = setTimeout(() => this.forfeit(p, false), GRACE);
    this.bcast({ t: 'away', i: p.idx, away: true });
  }
  rejoin(ws, token) {
    const p = this.players.find(x => x.token === token && !x.out);
    if (!p || this.phase !== 'game' || !this.game) return false;
    clearTimeout(p.dc); p.dc = null;
    if (p.ws && p.ws !== ws) { p.ws.room = null; try { p.ws.terminate(); } catch (e) { } }
    p.ws = ws; ws.room = this; ws.pid = p.id; ws.name = p.name;
    if (!names.has(p.name.toLowerCase())) names.set(p.name.toLowerCase(), ws);
    this.sendStart(p); send(ws, Object.assign({ t: 's' }, this.game.snap()));
    this.bcast({ t: 'away', i: p.idx, away: false }); return true;
  }
  /* a player left (gone) or stayed away too long: their wizard falls, and a team with nobody left loses */
  forfeit(p, gone) {
    clearTimeout(p.dc); if (this.phase !== 'game' || !this.game) return;
    p.out = true; p.gone = p.gone || gone;
    const w = this.game.wiz[p.idx];
    if (w && w.alive) { w.hp = 0; w.alive = false; this.bcast({ t: 'ev', e: [{ e: 'kill', i: p.idx, x: w.x, y: w.y }] }); }
    this.bcast({ t: 'away', i: p.idx, away: false });
    const act = t => this.order.some(q => q.team === t && !q.out);
    if (act(0) && act(1)) return;
    this.bcast({ t: 'forfeit', win: act(0) ? 0 : act(1) ? 1 : -1 }); this.finish();
  }
}

function leave(ws) {
  const r = ws.room; if (!r) return; const p = r.by(ws); ws.room = null; if (!p) return;
  if (r.phase === 'lobby') r.remove(p); else r.forfeit(p, true);
}

wss.on('connection', ws => {
  ws.isAlive = true; ws.cnt = 0; ws.room = null; ws.name = ''; ws.pid = 0;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', raw => {
    if (++ws.cnt > 150) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const r = ws.room;
    if (m.t === 'rejoin') {
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room || !room.rejoin(ws, String(m.token || ''))) send(ws, { t: 'err', msg: 'That match has ended.', fatal: true });
      return;
    }
    if (m.t === 'hello') {
      if (r || ws.authing) return;
      ws.authing = true;
      verifyFirebaseToken(m.token).then(async p => {
        if (ws.readyState !== 1 || ws.room) return;
        /* the name comes from the signed-in account, not from the client */
        /* the name comes from the account's permanent Firestore profile, never from the client */
        const n = clean(await fetchPlayerName(p.sub, m.token));
        if (ws.readyState !== 1 || ws.room) return;
        if (!n) return send(ws, { t: 'err', msg: 'Choose your wizard name first.', needName: true });
        /* one connection per account: take over an idle old one, refuse if that account is mid-match */
        for (const o of wss.clients) {
          if (o !== ws && o.uid === p.sub) {
            if (o.room && o.room.phase === 'game') return send(ws, { t: 'err', msg: 'This account is already in a match.' });
            try { o.terminate(); } catch (e) { }
          }
        }
        const k = n.toLowerCase(), o = names.get(k);
        if (o && o !== ws && o.readyState === 1 && o.uid !== p.sub) return send(ws, { t: 'err', msg: 'That name is taken, try another.' });
        if (ws.name) names.delete(ws.name.toLowerCase());
        ws.uid = p.sub; ws.name = n; names.set(k, ws); send(ws, { t: 'hello', name: n }); send(ws, roomsMsg());
      }).catch(e => {
        if (e.message === 'auth not configured') return send(ws, { t: 'err', msg: 'Online play is not set up yet.' });
        if (/^profile lookup/.test(e.message)) return send(ws, { t: 'err', msg: 'Could not load your profile. Try again in a moment.' });
        console.warn('sign-in check failed:', e.message);
        send(ws, { t: 'err', msg: 'Sign-in check failed (' + e.message + '). Please try again.', needAuth: true });
      }).finally(() => { ws.authing = false; });
      return;
    }
    if (!ws.name) return;
    const me = r && r.by(ws), host = !!me && me.id === r.hostId;
    switch (m.t) {
      case 'create': {
        if (r) return;
        const n = Math.max(1, Math.min(MAXN, m.n | 0 || 1)), room = new Room(n, !!m.locked);
        room.add(ws, 0); room.sync(); break;
      }
      case 'join': {
        if (r) return;
        const room = rooms.get(String(m.code || '').toUpperCase());
        if (!room) return send(ws, { t: 'err', msg: 'Room not found.' });
        if (room.phase !== 'lobby') return send(ws, { t: 'err', msg: 'That match already started.' });
        if (room.locked) return send(ws, { t: 'err', msg: 'That room is locked.' });
        const t = room.pickTeam(m.team); if (t === undefined) return send(ws, { t: 'err', msg: 'That room is full.' });
        room.add(ws, t); room.sync(); break;
      }
      case 'team': {
        if (!r || r.phase !== 'lobby' || (m.team !== 0 && m.team !== 1)) break;
        if (me.team !== m.team && r.team(m.team).length < r.n) { me.team = m.team; r.sync(); }
        break;
      }
      case 'mode': {
        if (!host || r.phase !== 'lobby') break;
        const n = Math.max(1, Math.min(MAXN, m.n | 0 || 1));
        if (n >= Math.max(r.team(0).length, r.team(1).length)) { r.n = n; r.sync(); }
        break;
      }
      case 'map': {
        if (!host || r.phase !== 'lobby') break;
        const id = typeof m.id === 'string' ? m.id : '';
        if (id === '' || seedForMap(id) !== null) { r.map = id; r.sync(); }
        break;
      }
      case 'lock': if (host) { r.locked = !!m.locked; r.sync(); } break;
      case 'kick': {
        if (!host || r.phase !== 'lobby') break;
        const t = r.players.find(p => p.id === m.id);
        if (t && t !== me) { send(t.ws, { t: 'left', msg: 'The host removed you from the room.' }); const tw = t.ws; r.remove(t); send(tw, roomsMsg()); }
        break;
      }
      case 'start':
        if (host) {
          if (r.phase === 'lobby' && typeof m.map === 'string' && (m.map === '' || seedForMap(m.map) !== null)) r.map = m.map;   /* the pick travels with Start too */
          r.start(ws);
        }
        break;
      case 'act': if (r && r.phase === 'game' && r.game && r.game.state !== 'over' && me && !me.out && m.m && typeof m.m === 'object') r.game.act(me.idx, m.m); break;
      case 'leave': leave(ws); send(ws, roomsMsg()); break;
    }
  });
  ws.on('close', () => {
    if (ws.name && names.get(ws.name.toLowerCase()) === ws) names.delete(ws.name.toLowerCase());
    if (ws.room) ws.room.drop(ws);
  });
  ws.on('error', () => { });
});
setInterval(() => { for (const ws of wss.clients) ws.cnt = 0; }, 1000);
setInterval(() => {
  if (!lobbyDirty) return; lobbyDirty = false; const s = JSON.stringify(roomsMsg());
  for (const ws of wss.clients) if (ws.name && !ws.room && ws.readyState === 1) ws.send(s);
}, 400);
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) { } } }, 20000);

server.listen(PORT, () => console.log('Arcane Warfare server on port ' + PORT));
