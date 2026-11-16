'use strict';
/* Arcane Warfare server: serves the game files and runs authoritative online matches (core.js) over WebSocket. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Core = require('./core.js');

const PORT = process.env.PORT || 3000;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/core.js': ['core.js', 'text/javascript; charset=utf-8']
};
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/health') { res.writeHead(200); return res.end('ok'); }
  const f = STATIC[u];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, f[0]), (e, d) => {
    if (e) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' }); res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

const rooms = new Map();
let quickRoom = null;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => { for (; ;) { let c = ''; for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)]; if (!rooms.has(c)) return c; } };
const clean = n => String(n || '').replace(/[^\w \-.]/g, '').trim().slice(0, 14) || 'Wizard';
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const GRACE = 30000;

class Room {
  constructor() {
    this.code = newCode(); this.slots = [null, null]; this.game = null; this.loop = null; this.rematch = [false, false];
    rooms.set(this.code, this);
  }
  count() { return this.slots.filter(Boolean).length; }
  add(ws, name) {
    const idx = this.slots[0] ? 1 : 0;
    this.slots[idx] = { ws, name: clean(name), token: crypto.randomBytes(8).toString('hex'), dc: null };
    ws.room = this; ws.idx = idx; return idx;
  }
  start() {
    this.rematch = [false, false];
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.game = new Core.Game({ seed: this.seed, players: this.slots.map((s, i) => ({ name: s.name, team: i })) });
    /* core spawns wizards at y=0; drop them onto the ground first so they don't take fall damage */
    for (const w of this.game.wiz) { let y = 0; while (y < Core.H - 1 && !this.game.solid(w.x, y)) y++; w.y = y - 1; w.vy = 0; w.grounded = true; }
    this.evBuf = [];
    this.slots.forEach((s, i) => this.sendStart(i));
    clearInterval(this.loop);
    this.last = Date.now(); this.acc = 0; this.snapT = 0;
    this.loop = setInterval(() => this.tick(), 16);
  }
  sendStart(i) {
    const s = this.slots[i], g = this.game;
    send(s.ws, { t: 'start', code: this.code, token: s.token, idx: i, seed: this.seed, names: this.slots.map(x => x.name), carves: g.carves });
  }
  tick() {
    const g = this.game, now = Date.now(); let dt = Math.min(.1, (now - this.last) / 1000); this.last = now;
    this.acc += dt; this.snapT += dt;
    while (this.acc >= 1 / 60) { g.step(1 / 60); this.acc -= 1 / 60; const ev = g.drain(); if (ev.length) this.evBuf.push(...ev); }
    if (this.evBuf.length) { this.bcast({ t: 'ev', e: this.evBuf }); this.evBuf = []; }
    if (this.snapT >= .05 || g.state === 'over') {
      this.snapT = 0; this.bcast(Object.assign({ t: 's' }, g.snap()));
      if (g.state === 'over') { clearInterval(this.loop); this.loop = null; }
    }
  }
  bcast(o) { const s = JSON.stringify(o); for (const p of this.slots) if (p && p.ws && p.ws.readyState === 1) p.ws.send(s); }
  other(idx) { return this.slots[1 - idx]; }
  /* socket closed */
  drop(ws) {
    const idx = ws.idx, s = this.slots[idx];
    if (!s || s.ws !== ws) return;
    s.ws = null;
    if (!this.game || this.game.state === 'over') return this.close(idx);
    s.dc = setTimeout(() => this.close(idx), GRACE);
    const o = this.other(idx); if (o) send(o.ws, { t: 'opp', away: true });
  }
  rejoin(ws, token) {
    const idx = this.slots.findIndex(s => s && s.token === token);
    if (idx < 0 || !this.game) return false;
    const s = this.slots[idx]; clearTimeout(s.dc); s.dc = null;
    if (s.ws && s.ws !== ws) { s.ws.room = null; try { s.ws.terminate(); } catch (e) { } }
    s.ws = ws; ws.room = this; ws.idx = idx;
    this.sendStart(idx); send(ws, Object.assign({ t: 's' }, this.game.snap()));
    const o = this.other(idx); if (o) send(o.ws, { t: 'opp', away: false });
    return true;
  }
  /* idx leaves or is gone: end the room, tell the other player */
  close(idx) {
    const o = idx === undefined ? null : this.other(idx); if (o) send(o.ws, { t: 'left' });
    clearInterval(this.loop);
    for (const p of this.slots) if (p) { clearTimeout(p.dc); if (p.ws) p.ws.room = null; }
    rooms.delete(this.code); if (quickRoom === this) quickRoom = null;
  }
}

function leave(ws) { const r = ws.room; if (r) { ws.room = null; r.close(ws.idx); } }

wss.on('connection', ws => {
  ws.isAlive = true; ws.cnt = 0; ws.room = null;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', raw => {
    if (++ws.cnt > 150) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const r = ws.room;
    switch (m.t) {
      case 'create': {
        leave(ws); const room = new Room(); room.add(ws, m.name);
        send(ws, { t: 'lobby', code: room.code, token: room.slots[0].token, quick: false }); break;
      }
      case 'join': {
        leave(ws); const room = rooms.get(String(m.code || '').toUpperCase());
        if (!room || room.game || room.count() !== 1) return send(ws, { t: 'err', msg: 'Room not found or already full.' });
        room.add(ws, m.name); room.start(); break;
      }
      case 'quick': {
        leave(ws);
        if (quickRoom && rooms.has(quickRoom.code) && !quickRoom.game && quickRoom.count() === 1) {
          const room = quickRoom; quickRoom = null; room.add(ws, m.name); room.start();
        } else {
          const room = new Room(); room.add(ws, m.name); quickRoom = room;
          send(ws, { t: 'lobby', code: room.code, token: room.slots[0].token, quick: true });
        }
        break;
      }
      case 'rejoin': {
        const room = rooms.get(String(m.code || '').toUpperCase());
        if (!room || !room.rejoin(ws, String(m.token || ''))) send(ws, { t: 'err', msg: 'That match has ended.', fatal: true });
        break;
      }
      case 'act': if (r && r.game && r.game.state !== 'over' && m.m && typeof m.m === 'object') r.game.act(ws.idx, m.m); break;
      case 'rematch': {
        if (!r || !r.game || r.game.state !== 'over' || r.count() !== 2) break;
        r.rematch[ws.idx] = true;
        if (r.rematch[0] && r.rematch[1]) r.start(); else { const o = r.other(ws.idx); if (o) send(o.ws, { t: 'rematch' }); }
        break;
      }
      case 'leave': leave(ws); break;
    }
  });
  ws.on('close', () => { if (ws.room) ws.room.drop(ws); });
  ws.on('error', () => { });
});
setInterval(() => { for (const ws of wss.clients) ws.cnt = 0; }, 1000);
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) { } } }, 20000);

server.listen(PORT, () => console.log('Arcane Warfare server on port ' + PORT));
