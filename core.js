/* Arcane Warfare core: pure game logic, no rendering. Runs on the server (online) and in the browser (offline modes). */
(function (root) {
'use strict';
const W = 1400, H = 700, WATER = H - 45, G = 600;
/* ---------- Spell registry (add new spells here) ---------- */
const SPELLS = {
  fire: { name: 'Fireball', icon: '\u{1F525}', k: 9.5, g: G, wf: 1, r: 48, dmg: 40, mana: 0, col: '#ffa030' },
  bolt: { name: 'Lightning', icon: '\u26A1', k: 15, g: 60, wf: .15, r: 28, dmg: 30, mana: 25, col: '#8fe0ff' }
};
const SKEYS = Object.keys(SPELLS);
const COLS = [['#3d6fe0', '#23449e'], ['#d4365a', '#8a1f3c'], ['#2fae5a', '#1b6b38'], ['#e0a020', '#9a6a10'], ['#9a4fd0', '#5e2a8a'], ['#20b8b8', '#12797b']];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function rng(s) { return function () { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function carveMask(mask, cx, cy, r) {
  const r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
      const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= r2) mask[y * W + x] = 0;
    }
}
function genMask(seed) {
  const r = rng(seed), R = (a, b) => a + r() * (b - a), mask = new Uint8Array(W * H), hs = new Float32Array(W), p = [R(0, 6), R(0, 6), R(0, 6)];
  for (let x = 0; x < W; x++) {
    const h = 400 + 50 * Math.sin(x * .0048 + p[0]) + 32 * Math.sin(x * .013 + p[1]) + 13 * Math.sin(x * .036 + p[2]);
    const e = Math.max(0, (160 - x) / 160, (x - (W - 160)) / 160); hs[x] = h + e * e * 360;
    for (let y = Math.ceil(hs[x]); y < H; y++) mask[y * W + x] = 1;
  }
  const isl = [[R(480, 620), R(170, 230), R(90, 130)], [R(780, 920), R(190, 250), R(80, 120)]];
  for (const [cx, y0, hw] of isl) for (let x = Math.floor(cx - hw); x <= cx + hw; x++) {
    const u = (x - cx) / hw, top = Math.round(y0 + 4 * Math.sin(x * .05)), bot = Math.round(y0 + 22 + 70 * Math.pow(1 - u * u, .7));
    for (let y = top; y < bot; y++) mask[y * W + x] = 1;
  }
  for (let i = 0; i < 4; i++) {
    let x = R(420, 980), y = hs[x | 0] + R(55, 100); const lw = R(24, 38) / 2;
    for (let j = 0; j < 5; j++) {
      const nx = x + R(-55, 55), ny = y + R(-22, 22), n = Math.ceil(Math.hypot(nx - x, ny - y) / 3);
      for (let k = 0; k <= n; k++) carveMask(mask, x + (nx - x) * k / n, y + (ny - y) * k / n, lw);
      x = nx; y = ny;
    }
  }
  return mask;
}
function muzzle(w, ang) {
  const a = ang * Math.PI / 180, f = Math.cos(a) >= 0 ? 1 : -1, lx = Math.abs(Math.cos(a)), ly = -Math.sin(a);
  return [w.x + f * 1.2 * (3 + lx * 27), w.y + 1.2 * (-22 + ly * 27)];
}

class Game {
  /* o = { seed, players: [{ name, team, ai }] } */
  constructor(o) {
    this.seed = o.seed >>> 0; this.mask = genMask(this.seed);
    const r = this.rnd = rng(this.seed ^ 0x9e3779b9); this.R = (a, b) => a + r() * (b - a);
    this.wiz = []; this.projs = []; this.ev = []; this.carves = []; this.pid = 1; this.over = null;
    const n = o.players.length, ax = [];
    for (let i = 0; i < n; i++) ax.push(n > 1 ? 130 + i * (W - 260) / (n - 1) : W / 2);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ax[i], ax[j]] = [ax[j], ax[i]]; }
    o.players.forEach((p, i) => {
      const x = ax[i] + this.R(-25, 25);
      this.wiz.push({ i, name: p.name, team: p.team, ai: !!p.ai, x, y: 0, vx: 0, vy: 0, hp: 100, mana: 60, angle: x < W / 2 ? 45 : 135, power: 60, spell: 'fire', alive: true, grounded: false, dir: 0 });
    });
    const groups = {}; this.wiz.forEach(w => (groups[w.team] = groups[w.team] || []).push(w.i));
    const gs = Object.keys(groups).sort().map(k => groups[k]); this.order = [];
    for (let k = 0; gs.some(g => g.length > k); k++) for (const g of gs) if (g[k] !== undefined) this.order.push(g[k]);
    this.pos = 0; this.turn = this.order[0]; this.newTurn(true);
  }
  solid(x, y) { x = x | 0; y = y | 0; return x >= 0 && x < W && y >= 0 && y < H && this.mask[y * W + x] === 1; }
  newTurn(first) {
    const w = this.wiz[this.turn];
    this.wind = Math.round(this.R(-8, 8)); this.timer = 30; this.state = 'aim'; this.ai = { t: 0, plan: null, hold: 0 };
    if (!first) w.mana = Math.min(100, w.mana + 20);
    if (SPELLS[w.spell].mana > w.mana) w.spell = 'fire';
    for (const q of this.wiz) q.dir = 0;
  }
  endTurn() {
    for (const w of this.wiz) w.dir = 0;
    const al = this.wiz.filter(w => w.alive), teams = new Set(al.map(w => w.team));
    if (teams.size < 2) { this.state = 'over'; this.over = { team: al.length ? al[0].team : -1, names: al.map(w => w.name) }; return; }
    do { this.pos = (this.pos + 1) % this.order.length; } while (!this.wiz[this.order[this.pos]].alive);
    this.turn = this.order[this.pos]; this.newTurn(false);
  }
  /* ----- player actions (validated; safe to call with untrusted input) ----- */
  act(i, m) {
    const w = this.wiz[i]; if (!w || !w.alive || w.ai || !m) return;
    if (m.t === 'dir') { w.dir = m.v > 0 ? 1 : m.v < 0 ? -1 : 0; return; }
    if (this.state !== 'aim' || this.turn !== i) return;
    const n = v => typeof v === 'number' && isFinite(v);
    if (m.t === 'jump') { if (w.grounded) { w.vy = -330; w.grounded = false; } }
    else if (m.t === 'aim') { if (n(m.angle)) w.angle = clamp(m.angle, 0, 180); if (n(m.power)) w.power = clamp(m.power, 10, 100); }
    else if (m.t === 'spell') { if (SPELLS[m.k] && w.mana >= SPELLS[m.k].mana) w.spell = m.k; }
    else if (m.t === 'fire') {
      if (n(m.angle)) w.angle = clamp(m.angle, 0, 180); if (n(m.power)) w.power = clamp(m.power, 10, 100);
      if (SPELLS[m.spell] && w.mana >= SPELLS[m.spell].mana) w.spell = m.spell;
      this.fire(w);
    }
  }
  fire(w) {
    const sp = SPELLS[w.spell]; if (this.state !== 'aim' || w.mana < sp.mana) return;
    w.mana -= sp.mana;
    const a = w.angle * Math.PI / 180, [mx, my] = muzzle(w, w.angle);
    this.projs.push({ id: this.pid++, sp: w.spell, x: mx, y: my, vx: Math.cos(a) * w.power * sp.k, vy: -Math.sin(a) * w.power * sp.k, age: 0, owner: w });
    this.ev.push({ e: 'cast', i: w.i }); this.state = 'resolve'; this.resolveT = 0; this.settle = 0;
  }
  /* ----- simulation ----- */
  step(dt) {
    const c = this.wiz[this.turn], aim = this.state === 'aim';
    for (const w of this.wiz) {
      let walk = 0;
      if (aim && w === c && !w.ai && w.alive && w.dir) {
        const f = Math.cos(w.angle * Math.PI / 180) >= 0 ? 1 : -1; if (w.dir !== f) w.angle = 180 - w.angle; walk = w.dir * 75;
      }
      this.phys(w, dt, walk);
    }
    for (const p of this.projs) this.stepProj(p, dt);
    this.projs = this.projs.filter(p => !p.dead);
    if (aim) {
      this.timer -= dt;
      if (c.ai) this.runAI(c, dt);
      if (this.timer <= 0 && this.state === 'aim') this.endTurn();
    } else if (this.state === 'resolve') {
      this.resolveT += dt;
      const calm = !this.projs.length && this.wiz.every(w => !w.alive || (w.grounded && Math.abs(w.vx) < 8));
      this.settle = calm ? this.settle + dt : 0;
      if (this.settle > .9 || this.resolveT > 20) this.endTurn();
    }
  }
  phys(w, dt, walk) {
    if (!w.alive) return;
    w.grounded = w.vy >= 0 && (this.solid(w.x, w.y + 1) || this.solid(w.x - 4, w.y + 1) || this.solid(w.x + 4, w.y + 1));
    if (w.grounded) w.vy = 0; else w.vy += G * dt;
    const dx = (w.vx + walk) * dt;
    if (dx) {
      const nx = clamp(w.x + dx, 8, W - 8); let up = -1;
      for (let k = 0; k <= (w.grounded ? 10 : 0); k++) if (!this.solid(nx, w.y - k - 3) && !this.solid(nx, w.y - k - 14) && !this.solid(nx, w.y - k - 24)) { up = k; break; }
      if (up >= 0) { w.x = nx; w.y -= up; } else w.vx *= -.3;
    }
    w.vx *= Math.pow(w.grounded ? .02 : .6, dt);
    if (!w.grounded) {
      const ny = w.y + w.vy * dt;
      if (w.vy > 0) {
        const n = Math.ceil((ny - w.y) / 2) || 1; let hit = false;
        for (let s = 1; s <= n; s++) { const yy = w.y + (ny - w.y) * s / n; if (this.solid(w.x, yy) || this.solid(w.x - 4, yy) || this.solid(w.x + 4, yy)) { w.y = yy; hit = true; break; } }
        if (hit) {
          for (let i = 0; i < 14 && (this.solid(w.x, w.y) || this.solid(w.x - 4, w.y) || this.solid(w.x + 4, w.y)); i++) w.y--;
          if (w.vy > 520) this.hurt(w, (w.vy - 520) / 12, 0, 0);
          w.vy = 0; w.vx *= .5;
        } else w.y = ny;
      } else if (this.solid(w.x, ny - 26)) w.vy = 0; else w.y = ny;
    }
    if (w.alive && w.y > WATER - 6) { this.ev.push({ e: 'splash', x: w.x }); w.hp = 0; this.kill(w); }
  }
  hurt(w, d, kx, ky) {
    d = Math.round(d); if (d <= 0 || !w.alive) return;
    w.hp -= d; this.ev.push({ e: 'hurt', i: w.i, d }); w.vx += kx; w.vy += ky; if (ky < 0) w.grounded = false;
    if (w.hp <= 0) { w.hp = 0; this.kill(w); }
  }
  kill(w) { if (!w.alive) return; w.alive = false; this.ev.push({ e: 'kill', i: w.i, x: w.x, y: w.y }); }
  explode(x, y, key) {
    const sp = SPELLS[key]; carveMask(this.mask, x, y, sp.r); this.carves.push([Math.round(x), Math.round(y), sp.r]);
    this.ev.push({ e: 'boom', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, k: key });
    for (const w of this.wiz) {
      if (!w.alive) continue;
      const dx = w.x - x, dy = w.y - 14 - y, d = Math.hypot(dx, dy) || 1, RR = sp.r * 1.7;
      if (d < RR) { const f = 1 - d / RR; this.hurt(w, sp.dmg * f * 1.15, dx / d * 280 * f, (dy / d) * 280 * f - 90 * f); }
    }
  }
  stepProj(p, dt) {
    const sp = SPELLS[p.sp], n = Math.max(1, Math.ceil(Math.hypot(p.vx, p.vy) * dt / 4)), h = dt / n;
    for (let i = 0; i < n; i++) {
      p.vy += sp.g * h; p.vx += this.wind * 14 * sp.wf * h; p.x += p.vx * h; p.y += p.vy * h; p.age += h;
      if (p.y > WATER) { this.ev.push({ e: 'splash', x: p.x }); p.dead = true; return; }
      if (p.x < -150 || p.x > W + 150 || p.y > H + 100 || p.age > 12) { p.dead = true; return; }
      if (this.solid(p.x, p.y)) { this.explode(p.x, p.y, p.sp); p.dead = true; return; }
      for (const w of this.wiz) if (w.alive && (p.age > .25 || w !== p.owner) && Math.hypot(w.x - p.x, w.y - 14 - p.y) < 15) { this.explode(p.x, p.y, p.sp); p.dead = true; return; }
    }
  }
  /* ----- AI ----- */
  sim(w, ang, pow, sp, t) {
    const a = ang * Math.PI / 180, [mx, my] = muzzle(w, ang); let x = mx, y = my, vx = Math.cos(a) * pow * sp.k, vy = -Math.sin(a) * pow * sp.k; const h = 1 / 90;
    for (let i = 0; i < 900; i++) {
      vy += sp.g * h; vx += this.wind * 14 * sp.wf * h; x += vx * h; y += vy * h;
      if (y > WATER || x < 0 || x > W || this.solid(x, y)) break;
      if (Math.hypot(t.x - x, t.y - 14 - y) < 15) return 0;
    }
    let d = Math.hypot(x - t.x, y - (t.y - 14));
    if (Math.hypot(x - w.x, y - w.y) < sp.r * 1.8) d += 300;
    for (const o of this.wiz) if (o !== w && o.alive && o.team === w.team && Math.hypot(x - o.x, y - o.y) < sp.r * 1.6) d += 200;
    return d;
  }
  think(w) {
    const es = this.wiz.filter(t => t.alive && t.team !== w.team); if (!es.length) return { a: w.angle, p: w.power, k: 'fire' };
    es.sort((a, b) => Math.abs(a.x - w.x) - Math.abs(b.x - w.x)); const t = es[0]; let best = null;
    for (const k of SKEYS) {
      const sp = SPELLS[k]; if (sp.mana > w.mana) continue;
      for (let a = 4; a <= 176; a += 3) for (let p = 25; p <= 100; p += 5) { const s = this.sim(w, a, p, sp, t) - sp.r * .6; if (!best || s < best.s) best = { a, p, k, s }; }
    }
    if (!best) return { a: w.angle, p: w.power, k: 'fire' };
    return { a: clamp(best.a + this.R(-2.5, 2.5), 0, 180), p: clamp(best.p + this.R(-4, 4), 10, 100), k: best.k };
  }
  runAI(c, dt) {
    const ai = this.ai; ai.t += dt; if (!ai.plan && ai.t > .9) ai.plan = this.think(c);
    if (!ai.plan) return; const p = ai.plan; c.spell = p.k;
    c.angle += clamp(p.a - c.angle, -90 * dt, 90 * dt); c.power += clamp(p.p - c.power, -60 * dt, 60 * dt);
    if (Math.abs(p.a - c.angle) < .5 && Math.abs(p.p - c.power) < .5) { ai.hold += dt; if (ai.hold > .5) this.fire(c); }
    if (this.timer < 4) this.fire(c);
  }
  /* ----- output ----- */
  snap() {
    const r = v => Math.round(v * 10) / 10;
    return {
      turn: this.turn, state: this.state, timer: r(this.timer), wind: this.wind,
      w: this.wiz.map(w => [r(w.x), r(w.y), w.hp, Math.round(w.mana), r(w.angle), r(w.power), (this.state === 'aim' && w.i === this.turn) ? w.dir : 0, w.grounded ? 1 : 0, w.alive ? 1 : 0, SKEYS.indexOf(w.spell)]),
      p: this.projs.map(p => [p.id, SKEYS.indexOf(p.sp), r(p.x), r(p.y), Math.round(p.vx), Math.round(p.vy)]),
      over: this.over
    };
  }
  drain() { const e = this.ev; this.ev = []; return e; }
}

const api = { W, H, WATER, G, SPELLS, SKEYS, COLS, Game, genMask, carveMask, muzzle };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(this);
