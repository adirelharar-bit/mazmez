/* Mazmez game server.
   Serves the page from ./public and runs every table over WebSocket.
   The server shuffles, deals and settles; each player only ever receives their own cards,
   and the turn, the river and the other players' cards are sent only at the reveal. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const O = require("./public/omaha.js");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const STAKES = [5, 10, 15, 25, 50, 100];
const MAX_SEATS = 4;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json"
};

/* A small WebSocket server (RFC 6455) with no dependencies: text messages, ping/pong and close.
   Enough for the game, and nothing to install. */
const { EventEmitter } = require("events");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class Socket extends EventEmitter {
  constructor(sock, maxPayload) {
    super();
    this.sock = sock; this.readyState = 1; this.buf = Buffer.alloc(0); this.frags = []; this.max = maxPayload;
    sock.setNoDelay(true);
    sock.on("data", d => this._data(d));
    sock.on("close", () => this._closed());
    sock.on("error", () => this._closed());
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.readyState !== 1 || this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; if (this.buf.readUInt32BE(2)) return this.terminate(); len = this.buf.readUInt32BE(6); off = 10; }
      if (!masked || len > this.max) return this.terminate();
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 8) { this._send(8, Buffer.alloc(0)); return this.terminate(); }
      if (op === 9) { this._send(10, payload); continue; }
      if (op === 10) { this.emit("pong"); continue; }
      if (op === 0 || op === 1 || op === 2) {
        this.frags.push(payload);
        if (this.frags.reduce((a, b) => a + b.length, 0) > this.max) return this.terminate();
        if (fin) { const msg = Buffer.concat(this.frags); this.frags = []; this.emit("message", msg.toString("utf8")); }
        continue;
      }
      return this.terminate();
    }
  }
  _send(op, data) {
    if (this.readyState !== 1) return;
    const len = data.length;
    let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
    this.sock.write(Buffer.concat([h, data]));
  }
  send(str) { this._send(1, Buffer.from(String(str), "utf8")); }
  ping() { this._send(9, Buffer.alloc(0)); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.sock.destroy(); this._closed(); }
  _closed() { if (this._done) return; this._done = true; this.readyState = 3; this.emit("close"); }
}

class WebSocketServer extends EventEmitter {
  constructor({ server, path, maxPayload = 64 * 1024 }) {
    super();
    this.clients = new Set();
    server.on("upgrade", (req, sock, head) => {
      let p = ""; try { p = new URL(req.url, "http://x").pathname; } catch {}
      const key = req.headers["sec-websocket-key"];
      if (p !== path || !key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") { sock.destroy(); return; }
      const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
      const ws = new Socket(sock, maxPayload);
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      this.emit("connection", ws, req);
      if (head && head.length) ws._data(head);
    });
  }
}

if (!fs.existsSync(path.join(PUB, "index.html"))) {
  console.error("חסרה התיקייה public עם הקובץ index.html. העלו את התיקייה public למאגר, יחד עם server.js.");
  process.exit(1);
}

/* ---------- static files ---------- */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("לא נמצא"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
});

/* ---------- helpers ---------- */
const tables = new Map();
const rid = () => crypto.randomBytes(6).toString("hex");
const rand = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
function newCode() {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (;;) { let s = ""; for (let i = 0; i < 4; i++) s += a[crypto.randomInt(a.length)]; if (!tables.has(s)) return s; }
}
function shuffled() {
  const d = O.fullDeck();
  for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const cleanName = s => String(s || "").replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, "").trim().slice(0, 24) || "שחקן";
const human = p => !p.bot;
const present = p => p.bot || p.socks.size > 0;

/* ---------- table logic ---------- */
function makeTable(stake, practice) {
  const t = {
    code: newCode(), stake: STAKES.includes(stake) ? stake : 5, practice: !!practice,
    players: [], hostId: null, phase: "lobby", round: 0, seats: [], per: 4,
    hands: null, boards: null, places: {}, placeSeq: {}, locked: {}, shown: false, result: null, touched: Date.now()
  };
  tables.set(t.code, t);
  return t;
}
function addPlayer(t, token, name, bot) {
  const p = { id: rid(), token, name: cleanName(name), bot: !!bot, socks: new Set(), total: 0, joined: Date.now() + t.players.length };
  t.players.push(p);
  return p;
}
const byId = (t, id) => t.players.find(p => p.id === id);
function lobbySeats(t) { return t.players.filter(present).slice(0, MAX_SEATS).map(p => p.id); }
function fixHost(t) {
  const h = byId(t, t.hostId);
  if (h && present(h)) return;
  const next = t.players.find(p => human(p) && present(p));
  if (next) t.hostId = next.id;
}

function deal(t) {
  t.seats = lobbySeats(t);
  const n = t.seats.length;
  t.per = n === 4 ? 3 : 4;
  const d = shuffled();
  t.hands = {}; t.places = {}; t.locked = {}; t.placeSeq = {};
  t.seats.forEach(id => { t.hands[id] = d.splice(0, t.per * 3); t.places[id] = [[], [], []]; });
  t.boards = [0, 1, 2].map(() => ({ flop: d.splice(0, 3), turn: d.pop(), river: d.pop() }));
  t.round += 1; t.phase = "play"; t.shown = false; t.result = null;
  const flops = t.boards.map(b => b.flop);
  t.seats.forEach(id => {
    const p = byId(t, id);
    if (p.bot) { t.places[id] = O.botArrange(t.hands[id], t.per, flops, rand); t.locked[id] = true; }
  });
}
function checkReveal(t) {
  if (t.phase !== "play" || t.shown) return;
  if (!t.seats.every(id => t.locked[id])) return;
  t.shown = true;
  t.result = O.settle(t.seats, t.stake, t.hands, t.per, t.boards, t.places);
  for (const id in t.result.net) { const p = byId(t, id); if (p) p.total = Math.round((p.total + t.result.net[id]) * 100) / 100; }
}
function toLobby(t) { // an unfinished hand is cancelled: no money moves
  t.phase = "lobby"; t.hands = null; t.boards = null; t.places = {}; t.locked = {}; t.shown = false; t.result = null; t.seats = [];
}

/* what one player is allowed to see */
function view(t, me) {
  const play = t.phase === "play";
  const seated = play && t.seats.includes(me.id);
  return {
    type: "state", code: t.code, practice: t.practice, you: me.id, hostId: t.hostId, stake: t.stake,
    phase: t.phase, round: t.round, per: t.per,
    players: t.players.filter(p => present(p) || t.seats.includes(p.id) || p.total !== 0)
      .map(p => ({ id: p.id, name: p.name, online: present(p), bot: p.bot, total: p.total })),
    seats: play ? t.seats : lobbySeats(t),
    locked: play ? Object.fromEntries(t.seats.map(id => [id, !!t.locked[id]])) : {},
    hand: seated ? t.hands[me.id] : [],
    place: seated ? t.places[me.id] : null,
    placeSeq: seated ? (t.placeSeq[me.id] || 0) : 0,
    flops: play ? t.boards.map(b => b.flop) : null,
    boards: play && t.shown ? t.boards : null,
    result: play && t.shown ? t.result : null
  };
}
function broadcast(t) {
  t.touched = Date.now();
  for (const p of t.players) for (const ws of p.socks) send(ws, view(t, p));
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
const fail = (ws, msg, extra) => send(ws, { type: "error", msg, ...extra });

/* ---------- connections ---------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 * 1024 });

wss.on("connection", ws => {
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));
  ws.ctx = null; // {t, p}

  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== "string") return;
    try { handle(ws, m); } catch (e) { console.error(e); fail(ws, "משהו השתבש. נסו שוב."); }
  });
  ws.on("close", () => detach(ws));
});

function attach(ws, t, p) {
  detach(ws);
  ws.ctx = { t, p };
  p.socks.add(ws);
  fixHost(t);
}
function detach(ws) {
  const c = ws.ctx; if (!c) return;
  ws.ctx = null;
  c.p.socks.delete(ws);
  fixHost(c.t);
  broadcast(c.t);
}

function handle(ws, m) {
  const token = typeof m.token === "string" ? m.token.slice(0, 64) : null;

  if (m.type === "create") {
    if (!token) return;
    const t = makeTable(+m.stake, m.practice);
    const p = addPlayer(t, token, m.name, false);
    t.hostId = p.id;
    attach(ws, t, p);
    if (t.practice) {
      const bots = Math.min(3, Math.max(1, +m.bots || 1));
      for (let i = 1; i <= bots; i++) addPlayer(t, null, "מחשב " + i, true);
      deal(t);
    }
    broadcast(t); return;
  }

  if (m.type === "join") {
    const code = String(m.code || "").toUpperCase().slice(0, 4);
    const t = tables.get(code);
    if (!t || !token) return fail(ws, "לא מצאנו שולחן עם הקוד הזה. בדקו את הקוד מול המארח.", { gone: true });
    let p = t.players.find(x => x.token === token);
    if (!p) {
      if (t.practice) return fail(ws, "זה שולחן תרגול פרטי.", { gone: true });
      p = addPlayer(t, token, m.name, false);
    } else if (m.name) p.name = cleanName(m.name);
    attach(ws, t, p); broadcast(t); return;
  }

  const c = ws.ctx; if (!c) return;
  const { t, p } = c;
  const isHost = t.hostId === p.id;
  const seated = t.phase === "play" && t.seats.includes(p.id);

  switch (m.type) {
    case "stake":
      if (isHost && t.phase === "lobby" && STAKES.includes(+m.stake)) t.stake = +m.stake;
      break;
    case "deal":
      if (!isHost) return;
      if (t.phase === "play" && !t.shown) return fail(ws, "היד הנוכחית עוד לא נחשפה.");
      if (lobbySeats(t).length < 2) return fail(ws, "צריך לפחות שני שחקנים כדי לחלק.");
      deal(t);
      break;
    case "place": {
      if (!seated || t.shown || t.locked[p.id]) return;
      const hand = t.hands[p.id], b = m.b, seen = new Set();
      if (!Array.isArray(b) || b.length !== 3) return;
      for (const row of b) {
        if (!Array.isArray(row) || row.length > t.per) return;
        for (const card of row) { if (!hand.includes(card) || seen.has(card)) return; seen.add(card); }
      }
      t.places[p.id] = b.map(r => [...r]);
      t.placeSeq[p.id] = Math.max(t.placeSeq[p.id] || 0, +m.seq || 0);
      break;
    }
    case "lock":
      if (!seated || t.shown) return;
      if (!O.validPlace(t.hands[p.id], t.per, t.places[p.id])) return fail(ws, "צריך להניח את כל הקלפים לפני הנעילה.");
      t.locked[p.id] = true; checkReveal(t);
      break;
    case "unlock":
      if (seated && !t.shown) t.locked[p.id] = false;
      break;
    case "lobby":
      if (isHost) toLobby(t);
      break;
    case "leave":
      if (!(t.phase === "play" && t.seats.includes(p.id)) && p.total === 0) t.players = t.players.filter(x => x !== p);
      detach(ws);
      if (!t.players.some(human)) tables.delete(t.code);
      return;
    default:
      return;
  }
  broadcast(t);
}

/* keep connections alive and drop idle tables */
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch {} }
  const now = Date.now();
  for (const [code, t] of tables) {
    const someone = t.players.some(p => human(p) && p.socks.size);
    const idle = now - t.touched;
    if (!someone && (idle > (t.practice ? 10 : 6 * 60) * 60e3)) tables.delete(code);
  }
}, 30e3);

server.listen(PORT, () => console.log(`mazmez רץ על http://localhost:${PORT}`));
