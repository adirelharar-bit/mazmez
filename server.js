/* Mazmez game server.
   Serves the page from ./public and runs every table over WebSocket.
   The server shuffles, deals and settles; each player only ever receives their own cards,
   and the turn, the river and the other players' cards are sent only at the reveal. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("./lib/ws-lite.js");
const O = require("./public/omaha.js");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const STAKES = [5, 10, 15, 25, 50, 100];
const MAX_SEATS = 4;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json"
};

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
