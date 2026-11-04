/* Mazmez game server.
   Serves the page from ./public and runs every table over WebSocket.
   The server shuffles, deals and settles; each player only ever receives their own cards,
   and the turn, the river and the other players' cards are sent only at the reveal. */
"use strict";
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const OMAHA_SRC = "/* Mazmez rules engine, shared by the server (Node) and the browser. */\n(function (root) {\n  \"use strict\";\n  const RANKS = \"23456789TJQKA\", SUITS = \"shdc\";\n  const rv = c => RANKS.indexOf(c[0]) + 2;\n  const HAND_NAMES = [\"קלף גבוה\", \"זוג\", \"שני זוגות\", \"שלישייה\", \"סטרייט\", \"פלאש\", \"פול האוס\", \"רביעייה\", \"סטרייט פלאש\"];\n  const handName = e => (e.cat === 8 && e.high === 14 ? \"רויאל פלאש\" : HAND_NAMES[e.cat]);\n\n  function fullDeck() { const d = []; for (const r of RANKS) for (const s of SUITS) d.push(r + s); return d; }\n\n  function eval5(cs) {\n    const r = cs.map(rv).sort((a, b) => b - a);\n    const flush = cs.every(c => c[1] === cs[0][1]);\n    const cnt = {}; r.forEach(x => (cnt[x] = (cnt[x] || 0) + 1));\n    const g = Object.entries(cnt).map(([k, v]) => [+k, v]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);\n    let sh = 0;\n    if (g.length === 5) { if (r[0] - r[4] === 4) sh = r[0]; else if (r[0] === 14 && r[1] === 5) sh = 5; }\n    let cat, k;\n    if (sh && flush) { cat = 8; k = [sh]; }\n    else if (g[0][1] === 4) { cat = 7; k = [g[0][0], g[1][0]]; }\n    else if (g[0][1] === 3 && g[1][1] === 2) { cat = 6; k = [g[0][0], g[1][0]]; }\n    else if (flush) { cat = 5; k = r; }\n    else if (sh) { cat = 4; k = [sh]; }\n    else if (g[0][1] === 3) { cat = 3; k = g.map(x => x[0]); }\n    else if (g[0][1] === 2 && g[1][1] === 2) { cat = 2; k = g.map(x => x[0]); }\n    else if (g[0][1] === 2) { cat = 1; k = g.map(x => x[0]); }\n    else { cat = 0; k = r; }\n    let s = cat; for (let i = 0; i < 5; i++) s = s * 15 + (k[i] || 0);\n    return { s, cat, high: k[0] };\n  }\n\n  // Omaha: exactly two hole cards and exactly three board cards\n  function bestOmaha(hole, board) {\n    let best = null;\n    for (let i = 0; i < hole.length; i++) for (let j = i + 1; j < hole.length; j++)\n      for (let a = 0; a < board.length; a++) for (let b = a + 1; b < board.length; b++) for (let c = b + 1; c < board.length; c++) {\n        const e = eval5([hole[i], hole[j], board[a], board[b], board[c]]);\n        if (!best || e.s > best.s) best = { ...e, used: [hole[i], hole[j], board[a], board[b], board[c]] };\n      }\n    return best;\n  }\n\n  function validPlace(hand, per, pl) {\n    if (!hand || !Array.isArray(pl) || pl.length !== 3) return false;\n    const seen = new Set();\n    for (const b of pl) {\n      if (!Array.isArray(b) || b.length !== per) return false;\n      for (const c of b) { if (!hand.includes(c) || seen.has(c)) return false; seen.add(c); }\n    }\n    return true;\n  }\n\n  /* Each seated player puts `stake` on every board. The best hand takes that board's pot;\n     a tie splits it. A player who wins all three boards alone gets one more stake from everyone. */\n  function settle(seats, stake, hands, per, boards, places) {\n    const n = seats.length, net = {}, out = [];\n    seats.forEach(p => (net[p] = 0));\n    for (let b = 0; b < 3; b++) {\n      const B = boards[b], five = [...B.flop, B.turn, B.river];\n      const rows = seats.map(p => {\n        const ok = validPlace(hands[p], per, places[p]);\n        const e = ok ? bestOmaha(places[p][b], five) : null;\n        return { p, ok, hole: ok ? places[p][b] : [], s: e ? e.s : -1 };\n      });\n      const live = rows.filter(x => x.ok);\n      if (!live.length) { out.push({ rows, win: [], pot: 0 }); continue; }\n      const top = Math.max(...live.map(x => x.s));\n      const win = live.filter(x => x.s === top).map(x => x.p);\n      const pot = n * stake, share = pot / win.length;\n      rows.forEach(x => { net[x.p] -= stake; if (win.includes(x.p)) net[x.p] += share; });\n      out.push({ rows, win, pot });\n    }\n    const w0 = out[0].win;\n    const scoop = w0.length === 1 && out.every(bd => bd.win.length === 1 && bd.win[0] === w0[0]) ? w0[0] : null;\n    if (scoop) seats.forEach(p => { if (p !== scoop) { net[p] -= stake; net[scoop] += stake; } });\n    for (const p in net) net[p] = Math.round(net[p] * 100) / 100;\n    return { boards: out, net, scoop };\n  }\n\n  // Computer player: tries many splits and keeps the strongest one against the three flops\n  function botArrange(hand, per, flops, rand) {\n    rand = rand || Math.random;\n    let best = null, bestScore = -1;\n    for (let t = 0; t < 400; t++) {\n      const h = [...hand];\n      for (let i = h.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [h[i], h[j]] = [h[j], h[i]]; }\n      const split = [h.slice(0, per), h.slice(per, 2 * per), h.slice(2 * per, 3 * per)];\n      let sc = 0;\n      split.forEach((cs, b) => { const e = bestOmaha(cs, flops[b]); sc += e.cat * 1e3 + e.high * 10 + cs.reduce((a, c) => a + rv(c), 0) / 10; });\n      if (sc > bestScore) { bestScore = sc; best = split; }\n    }\n    return best;\n  }\n\n  const api = { RANKS, SUITS, rv, handName, fullDeck, eval5, bestOmaha, validPlace, settle, botArrange };\n  if (typeof module !== \"undefined\" && module.exports) module.exports = api;\n  else root.Omaha = api;\n})(typeof self !== \"undefined\" ? self : this);\n";
const O = (() => { const module = { exports: {} }; new Function("module", OMAHA_SRC)(module); return module.exports; })();

const PORT = process.env.PORT || 3000;
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

/* ---------- the page (embedded, so the server is a single file) ---------- */
const FILES = {
  "/index.html": { type: MIME[path.extname("index.html")], body: "<!doctype html>\n<html lang=\"he\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#14090b\">\n<meta name=\"description\" content=\"אומהה על שלושה לוחות לשניים עד ארבעה שחקנים, אונליין עם חברים.\">\n<title>mazmez</title>\n<link rel=\"icon\" href=\"icon.svg\" type=\"image/svg+xml\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Secular+One&family=Assistant:wght@400;600;700&family=Frank+Ruhl+Libre:wght@700;900&display=swap\" rel=\"stylesheet\">\n<style>\n*,*::before,*::after{box-sizing:border-box}\nhtml{-webkit-text-size-adjust:100%;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}\nbody{margin:0}\n[hidden]{display:none!important}\n\n/* Layout: one phone-width column on oxblood felt — code and balances on top, three boards stacked, the hand tray sticky at the bottom */\n:root{\n  --felt:#2b1216; --felt-hi:#45191f; --rail:#14090b; --brass:#d6ad5c; --brass-dim:#8c6b34;\n  --ivory:#f5efe2; --ink:#1c1315; --red:#b02531; --muted:#c4ae9f; --line:rgba(214,173,92,.28);\n  --good:#86c99b; --bad:#e58b8b;\n  --suit-s:#1c1315; --suit-h:#b5202d; --suit-d:#1d59b8; --suit-c:#1b7a3a;\n  --display:\"Secular One\",\"Assistant\",system-ui,sans-serif;\n  --body:\"Assistant\",system-ui,sans-serif;\n  --pip:\"Frank Ruhl Libre\",Georgia,serif;\n  color-scheme:dark;\n}\nhtml,body{height:100%}\nbody{\n  background:radial-gradient(130% 70% at 50% 0%,var(--felt-hi),var(--felt) 55%,var(--rail));\n  background-color:var(--rail);\n  color:var(--ivory);font-family:var(--body);font-size:16px;line-height:1.45;direction:rtl;\n}\n#app{\n  max-width:540px;margin:0 auto;min-height:100%;display:flex;flex-direction:column;gap:14px;\n  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));\n  padding-block:14px 0;\n}\nbutton,input,select{font:inherit;color:inherit}\nbutton{cursor:pointer}\n:focus-visible{outline:2px solid var(--brass);outline-offset:2px}\n\n.top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}\n.brand{font-family:var(--display);font-size:1.45rem;letter-spacing:.01em;color:var(--brass);line-height:1}\n.brand small{display:block;font-family:var(--body);font-size:.72rem;color:var(--muted);letter-spacing:.06em;margin-top:4px}\n.codechip{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;padding:4px 6px 4px 12px;background:rgba(0,0,0,.25)}\n.codechip b{font-family:var(--pip);font-weight:900;letter-spacing:.16em;direction:ltr}\n.dot{width:8px;height:8px;border-radius:50%;background:var(--bad)}\n.dot.on{background:var(--good)}\n.ghost{background:none;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:.8rem;color:var(--muted)}\n.ghost:hover{color:var(--ivory);border-color:var(--brass-dim)}\n\n.btn{background:var(--brass);color:var(--ink);border:0;border-radius:10px;padding:12px 18px;font-weight:700;font-size:1rem}\n.btn:disabled{opacity:.4;cursor:not-allowed}\n.btn.alt{background:transparent;color:var(--brass);border:1.5px solid var(--brass-dim)}\n.field{display:flex;flex-direction:column;gap:6px}\n.field label{font-size:.78rem;color:var(--muted);letter-spacing:.05em}\n.field input,.field select{background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font-size:1rem}\n.field input.code{font-family:var(--pip);font-weight:900;letter-spacing:.3em;text-transform:uppercase;direction:ltr;text-align:center}\n\n.panel{border:1px solid var(--line);border-radius:14px;background:rgba(10,4,5,.35);padding:16px;display:flex;flex-direction:column;gap:14px}\n.panel h2{margin:0;font-family:var(--display);font-weight:400;font-size:1.15rem;color:var(--ivory)}\n.note{font-size:.88rem;color:var(--muted);margin:0}\n.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}\n.row > *{flex:1 1 140px;min-width:0}\n.rules{margin:0;padding-inline-start:18px;color:var(--muted);font-size:.9rem;display:grid;gap:4px}\n.err{color:var(--bad);font-size:.9rem;margin:0}\n\n.bigcode{font-family:var(--pip);font-weight:900;font-size:2.6rem;letter-spacing:.3em;color:var(--brass);direction:ltr;text-align:center;line-height:1}\n.seats{display:grid;gap:8px;list-style:none;margin:0;padding:0}\n.seats li{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.25)}\n.seats .tag{font-size:.75rem;color:var(--muted)}\n.seats li.empty{color:var(--muted);background:none;border:1px dashed var(--line)}\n\n/* balances */\n.players{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}\n.pl{border-radius:10px;padding:8px 10px;background:rgba(0,0,0,.28);border:1px solid transparent;display:flex;flex-direction:column;gap:2px;min-width:0}\n.pl.me{border-color:var(--brass-dim)}\n.pl .nm{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.pl .bal{font-family:var(--pip);font-weight:900;font-size:1.25rem;font-variant-numeric:tabular-nums;direction:ltr;text-align:right;line-height:1.1}\n.stakeline{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;font-size:.85rem;color:var(--muted)}\n.stakeline b{color:var(--brass);font-family:var(--pip)}\n.pl .st{font-size:.75rem;color:var(--muted)}\n.pl .st.ok{color:var(--good)}\n.pos{color:var(--good)} .neg{color:var(--bad)}\n\n/* boards */\n.board{border-radius:14px;padding:12px;background:rgba(0,0,0,.22);border:1px solid var(--line);display:flex;flex-direction:column;gap:10px;transition:border-color .15s,background .15s}\n.board.armed{border-color:var(--brass);background:rgba(214,173,92,.08)}\n.board.won{border-color:var(--brass)}\n.bh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}\n.bh h3{margin:0;font-family:var(--display);font-weight:400;font-size:1.05rem;color:var(--brass)}\n.bh .pot{font-size:.8rem;color:var(--muted)}\n.comm{display:flex;gap:6px;direction:ltr;justify-content:center;align-items:center}\n.comm .gap{width:6px}\n.mine{display:flex;gap:6px;direction:ltr;justify-content:center;padding:8px;border-radius:10px;background:rgba(0,0,0,.2);min-height:60px;align-items:center}\n.mine-wrap{display:flex;flex-direction:column;gap:4px}\n.cur{font-size:.8rem;color:var(--muted);text-align:center}\n.cur b{color:var(--ivory);font-weight:600}\n\n/* cards */\n.card{\n  --cw:42px;width:var(--cw);aspect-ratio:5/7;max-width:100%;container-type:inline-size;flex:none;\n  background:var(--ivory);color:var(--ink);border-radius:6px;border:0;padding:0;\n  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;\n  font-family:var(--pip);font-weight:900;line-height:.9;user-select:none;-webkit-user-select:none;\n  box-shadow:0 1px 0 rgba(0,0,0,.5),0 4px 10px rgba(0,0,0,.35);position:relative;\n}\n.card .r{font-size:44cqw}\n.card .s{font-size:38cqw;font-family:system-ui,sans-serif;font-weight:400}\n.card.su-s{color:var(--suit-s)} .card.su-h{color:var(--suit-h)} .card.su-d{color:var(--suit-d)} .card.su-c{color:var(--suit-c)}\n.comm .card,.mine .card{--cw:52px}\n.mine{min-height:86px}\n.card.back{background:repeating-linear-gradient(45deg,#6e2a31 0 4px,#56202a 4px 8px);box-shadow:inset 0 0 0 2px var(--ivory),0 4px 10px rgba(0,0,0,.35)}\n.card.slot{background:none;border:1.5px dashed var(--brass-dim);box-shadow:none}\n.card.sel{transform:translateY(-6px);box-shadow:0 0 0 3px var(--brass),0 8px 16px rgba(0,0,0,.5)}\n.card.dim{opacity:.35}\n.card.mini{--cw:30px;border-radius:4px}\n.card.use{box-shadow:0 0 0 2px var(--brass),0 2px 6px rgba(0,0,0,.4)}\nbutton.card{cursor:pointer}\n.flip{animation:flip .8s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--d,0s)}\n@keyframes flip{0%{transform:rotateY(90deg) scale(.85);opacity:.2}60%{transform:rotateY(0) scale(1.12)}100%{transform:none;opacity:1}}\n\n/* results */\n.res{display:grid;gap:6px}\n.rr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:center;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.2)}\n.rr.win{background:rgba(214,173,92,.16);box-shadow:inset 0 0 0 1px var(--brass-dim)}\n.rr .who{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.rr .hn{font-size:.82rem;color:var(--muted)}\n.rr.win .hn{color:var(--brass)}\n.rr .cs{grid-column:1/-1;display:flex;gap:4px;direction:ltr;justify-content:flex-end;flex-wrap:wrap}\n.summary{border-radius:14px;padding:14px;background:rgba(214,173,92,.1);border:1px solid var(--brass-dim);display:flex;flex-direction:column;gap:10px}\n.summary h3{margin:0;font-family:var(--display);font-weight:400;color:var(--brass)}\n.scoop{font-family:var(--display);font-size:1.2rem;color:var(--brass);text-align:center}\n.nets{display:grid;gap:4px;margin:0;padding:0;list-style:none}\n.nets li{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums}\n.nets li span:last-child{direction:ltr;font-family:var(--pip);font-weight:700}\n\n/* tray */\n.tray{\n  position:sticky;bottom:0;margin-top:auto;z-index:5;\n  margin-inline:calc(-1 * max(16px,env(safe-area-inset-left,0px)));\n  padding:10px max(16px,env(safe-area-inset-right,0px)) calc(12px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));\n  background:linear-gradient(to bottom,rgba(20,9,11,.85),var(--rail) 30%);\n  border-top:1px solid var(--line);display:flex;flex-direction:column;gap:10px;\n}\n.trayhead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}\n.trayhead .hint{font-size:.85rem;color:var(--muted)}\n.hand{display:grid;gap:6px;direction:ltr}\n.hand .card{width:100%;--cw:auto}\n.hand .card.placed{visibility:hidden}\n.actions{display:flex;gap:8px}\n.actions .btn{flex:1}\n.wait{text-align:center;color:var(--muted);font-size:.92rem;padding:4px 0}\n\n/* drag */\n.hand .card{touch-action:none}\n.board.over{border-color:var(--brass);background:rgba(214,173,92,.16)}\n.ghost-card{position:fixed;left:0;top:0;z-index:60;pointer-events:none;margin:-40px 0 0 -28px}\n.ghost-card .card{--cw:56px;transform:rotate(-6deg);box-shadow:0 0 0 3px var(--brass),0 14px 28px rgba(0,0,0,.55)}\n/* the board being revealed comes to the front */\n.spot-back{position:fixed;inset:0;z-index:40;background:rgba(12,5,6,.8);backdrop-filter:blur(3px)}\n.board.spot{\n  position:fixed;z-index:41;left:50%;top:50%;transform:translate(-50%,-50%);\n  width:min(500px,calc(100vw - 24px - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px)));max-height:calc(100% - 32px);overflow:auto;\n  background:radial-gradient(120% 90% at 50% 0%,var(--felt-hi),var(--felt));border:1.5px solid var(--brass);padding:16px;gap:14px;\n  box-shadow:0 30px 80px rgba(0,0,0,.6);\n}\n.board.spot.enter{animation:spotIn .6s cubic-bezier(.2,.8,.2,1) both}\n@keyframes spotIn{from{transform:translate(-50%,-40%) scale(.55);opacity:0}to{transform:translate(-50%,-50%);opacity:1}}\n.spot .bh h3{font-size:1.4rem}\n.spot .comm .card{--cw:min(60px,15vw)}\n.spot .card.mini{--cw:36px}\n.spot .stage{text-align:center;font-family:var(--display);color:var(--brass);font-size:1.05rem;min-height:1.5em}\n.spot .skip{align-self:center}\n.rr.lead{box-shadow:inset 0 0 0 1px var(--line)}\n.rr.lead .hn{color:var(--ivory)}\n.rr.win.pop{animation:pop .6s ease-out both}\n@keyframes pop{0%{transform:scale(.96)}50%{transform:scale(1.03)}100%{transform:none}}\n.board.waiting{opacity:.55}\n@media (prefers-reduced-motion:reduce){.flip,.board.spot.enter,.rr.win.pop{animation:none}.card.sel{transform:none}.board{transition:none}}\n</style>\n</head>\n<body>\n<div id=\"app\"></div>\n<noscript>כדי לשחק צריך להפעיל JavaScript.</noscript>\n<script src=\"omaha.js\"></script>\n<script src=\"app.js\"></script>\n</body>\n</html>\n" },
  "/app.js": { type: MIME[path.extname("app.js")], body: "/* Mazmez client: draws what the server sends and sends back the player's moves. */\n(() => {\n\"use strict\";\nconst O = window.Omaha;\nconst $ = s => document.querySelector(s);\nconst esc = s => String(s ?? \"\").replace(/[&<>\"']/g, c => ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[c]));\nconst store = {\n  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },\n  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },\n  del(k) { try { localStorage.removeItem(k); } catch {} }\n};\nconst SYM = { s: \"♠\", h: \"♥\", d: \"♦\", c: \"♣\" };\nconst STAKES = [5, 10, 15, 25, 50, 100];\nconst money = x => \"₪\" + (Math.round(Math.abs(x) * 100) / 100).toLocaleString(\"he-IL\", { maximumFractionDigits: 2 });\n// wrapped in a left-to-right isolate so \"+₪10\" keeps its order inside Hebrew text\nconst fmt = x => { const v = Math.round(x * 100) / 100; return \"\\u2066\" + (v > 0 ? \"+\" : v < 0 ? \"−\" : \"\") + money(v) + \"\\u2069\"; };\n\n/* ---------- identity ---------- */\nlet token = store.get(\"t3o:token\");\nif (!token) { token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, \"0\")).join(\"\"); store.set(\"t3o:token\", token); }\nlet myName = store.get(\"t3o:name\") || \"\";\nconst linkCode = (location.hash.match(/^#([A-Za-z0-9]{4})$/) || [])[1]?.toUpperCase() || \"\";\n\n/* ---------- connection ---------- */\nlet ws = null, conn = false, S = null, flash = \"\", retry = 0, pendingJoin = store.get(\"t3o:code\");\nfunction connect() {\n  ws = new WebSocket((location.protocol === \"https:\" ? \"wss://\" : \"ws://\") + location.host + \"/ws\");\n  ws.onopen = () => {\n    conn = true; retry = 0;\n    const code = S?.code || pendingJoin;\n    if (code) send({ type: \"join\", code, name: myName });\n    render();\n  };\n  ws.onmessage = e => {\n    let m; try { m = JSON.parse(e.data); } catch { return; }\n    if (m.type === \"state\") {\n      if (S && S.round !== m.round) { sel = null; placeSeq = 0; }\n      // keep my newest arrangement if this message answers an older move of mine\n      else if (S && S.place && m.place && (m.placeSeq || 0) < placeSeq) m.place = S.place;\n      S = m; pendingJoin = null; flash = \"\";\n      store.set(\"t3o:code\", m.code);\n      if (!m.practice && location.hash !== \"#\" + m.code) history.replaceState(null, \"\", \"#\" + m.code);\n    } else if (m.type === \"error\") {\n      flash = m.msg;\n      if (m.gone) { S = null; pendingJoin = null; store.del(\"t3o:code\"); }\n    }\n    render();\n  };\n  ws.onclose = () => {\n    conn = false; render();\n    setTimeout(connect, Math.min(8000, 600 * 2 ** retry++));\n  };\n}\nfunction send(m) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ token, ...m })); return true; } return false; }\n\n/* ---------- local view state ---------- */\nlet sel = null, sortBy = \"rank\", placeSeq = 0;\nconst me = () => S?.you;\nconst isHost = () => S && S.hostId === S.you;\nconst nameOf = id => S?.players.find(p => p.id === id)?.name || \"שחקן\";\nconst player = id => S?.players.find(p => p.id === id);\nconst seated = () => S && S.phase === \"play\" && S.seats.includes(S.you);\n\n/* ---------- cards ---------- */\nfunction cardHTML(c, o = {}) {\n  if (!c) return `<span class=\"card back ${o.mini ? \"mini\" : \"\"} ${o.cls || \"\"}\" aria-label=\"קלף סגור\"></span>`;\n  const tag = o.btn ? \"button\" : \"span\";\n  const r = c[0] === \"T\" ? \"10\" : c[0];\n  return `<${tag} class=\"card su-${c[1]} ${o.mini ? \"mini\" : \"\"} ${o.cls || \"\"}\" ${o.btn ? `type=\"button\" data-act=\"${o.btn}\" data-c=\"${c}\"` : \"\"} aria-label=\"${r}${SYM[c[1]]}\"><span class=\"r\">${r}</span><span class=\"s\">${SYM[c[1]]}</span></${tag}>`;\n}\nconst slotHTML = () => `<span class=\"card slot\"></span>`;\nconst sortCards = cs => [...cs].sort(sortBy === \"rank\"\n  ? (a, b) => O.rv(b) - O.rv(a) || O.SUITS.indexOf(a[1]) - O.SUITS.indexOf(b[1])\n  : (a, b) => O.SUITS.indexOf(a[1]) - O.SUITS.indexOf(b[1]) || O.rv(b) - O.rv(a));\n\n/* ---------- staged reveal: one board at a time ---------- */\nlet reveal = null, revealedRound = 0, lastSpotKey = \"\";\nconst STEP_MS = [1500, 1900, 1700, 2400]; // look at the hands, turn, river, winner\nconst STAGE_TXT = [\"הקלפים על השולחן…\", \"הטרן…\", \"הריבר…\", \"\"];\nfunction ensureReveal(round) {\n  if (revealedRound === round || (reveal && reveal.round === round)) return;\n  if (reveal) clearTimeout(reveal.t);\n  reveal = { round, b: 0, stage: 0 }; lastSpotKey = \"\"; scheduleReveal();\n}\nfunction scheduleReveal() { clearTimeout(reveal.t); reveal.t = setTimeout(stepReveal, STEP_MS[reveal.stage]); }\nfunction stepReveal() {\n  if (!reveal) return;\n  reveal.stage++;\n  if (reveal.stage > 3) { reveal.b++; reveal.stage = 0; }\n  if (reveal.b > 2) { revealedRound = reveal.round; reveal = null; render(); return; }\n  scheduleReveal(); render();\n}\nfunction skipReveal() { if (reveal) { clearTimeout(reveal.t); revealedRound = reveal.round; reveal = null; render(); } }\nconst stageOf = b => (!reveal ? 4 : b < reveal.b ? 4 : b === reveal.b ? reveal.stage : -1);\n\nfunction knownBoard(B, st) { return [...B.flop, ...(st >= 1 ? [B.turn] : []), ...(st >= 2 ? [B.river] : [])]; }\nfunction commHTML(flop, B, st, anim) {\n  return flop.map(c => cardHTML(c)).join(\"\") + `<span class=\"gap\"></span>` +\n    (B && st >= 1 ? cardHTML(B.turn, { cls: anim && st === 1 ? \"flip\" : \"\" }) : cardHTML(null)) +\n    (B && st >= 2 ? cardHTML(B.river, { cls: anim && st === 2 ? \"flip\" : \"\" }) : cardHTML(null));\n}\nfunction rowsHTML(bd, B, st, anim) {\n  const final = st >= 3, known = knownBoard(B, st);\n  const evals = bd.rows.map(x => (x.ok ? O.bestOmaha(x.hole, known) : null));\n  const live = evals.filter(Boolean);\n  const top = live.length ? Math.max(...live.map(e => e.s)) : null;\n  return `<div class=\"res\">${bd.rows.map((x, i) => {\n    const e = evals[i];\n    const w = final ? bd.win.includes(x.p) : e && e.s === top;\n    const used = new Set(final && e ? e.used : []);\n    const cs = x.ok ? x.hole.map(c => cardHTML(c, { mini: true, cls: final ? (used.has(c) ? \"use\" : \"dim\") : \"\" })).join(\"\") : \"\";\n    const share = final && w ? ` · ${fmt(bd.pot / bd.win.length)}` : \"\";\n    const cls = w ? (final ? `win ${anim ? \"pop\" : \"\"}` : \"lead\") : \"\";\n    return `<div class=\"rr ${cls}\"><span class=\"who\">${final && w ? \"★ \" : \"\"}${esc(nameOf(x.p))}</span><span class=\"hn\">${x.ok ? O.handName(e) + share : \"סידור לא תקין\"}</span><div class=\"cs\">${cs}</div></div>`;\n  }).join(\"\")}</div>`;\n}\n\n/* ---------- views ---------- */\nfunction topBar() {\n  let chip = \"\";\n  if (S) chip = `<div class=\"codechip\">${S.practice ? `<b style=\"letter-spacing:0\">משחק תרגול</b>`\n      : `<span class=\"dot ${conn ? \"on\" : \"\"}\" title=\"${conn ? \"מחובר\" : \"מתחבר…\"}\"></span><b>${esc(S.code)}</b><button class=\"ghost\" data-act=\"copy\">העתקת קישור</button>`}<button class=\"ghost\" data-act=\"leave\">יציאה</button></div>`;\n  else if (!conn) chip = `<div class=\"codechip\"><span class=\"dot\"></span><span class=\"note\">מתחברים לשרת…</span></div>`;\n  return `<div class=\"top\"><div class=\"brand\">mazmez<small>שלושה לוחות · שני קלפים בדיוק</small></div>${chip}</div>`;\n}\n\nfunction entryView() {\n  const stakeOpts = STAKES.map(v => `<option value=\"${v}\">${money(v)} לכל לוח</option>`).join(\"\");\n  return `${topBar()}\n  <div class=\"panel\">\n    <h2>מי משחק?</h2>\n    <div class=\"field\"><label for=\"nm\">הכינוי שלך ליד השולחן</label><input id=\"nm\" maxlength=\"24\" value=\"${esc(myName)}\" placeholder=\"למשל: אדיר\" autocomplete=\"nickname\"></div>\n    <div class=\"row\">\n      <div class=\"field\"><label for=\"jc\">קוד שולחן שקיבלת</label><input id=\"jc\" class=\"code\" maxlength=\"4\" placeholder=\"ABCD\" autocomplete=\"off\" value=\"${esc(linkCode)}\"></div>\n      <button class=\"btn ${linkCode ? \"\" : \"alt\"}\" data-act=\"join\" ${conn ? \"\" : \"disabled\"}>הצטרפות</button>\n    </div>\n    <div class=\"row\">\n      <div class=\"field\"><label for=\"stk\">או לפתוח שולחן חדש · הימור</label><select id=\"stk\">${stakeOpts}</select></div>\n      <button class=\"btn ${linkCode ? \"alt\" : \"\"}\" data-act=\"create\" ${conn ? \"\" : \"disabled\"}>פתיחת שולחן</button>\n    </div>\n    <div class=\"row\">\n      <div class=\"field\"><label for=\"nb\">או לשחק לבד מול המחשב</label>\n        <select id=\"nb\"><option value=\"1\">מול מחשב אחד</option><option value=\"2\">מול שני מחשבים</option><option value=\"3\">מול שלושה מחשבים (9 קלפים)</option></select></div>\n      <button class=\"btn alt\" data-act=\"solo\" ${conn ? \"\" : \"disabled\"}>משחק תרגול</button>\n    </div>\n    ${flash ? `<p class=\"err\">${esc(flash)}</p>` : \"\"}\n    ${!conn ? `<p class=\"note\">מתחברים לשרת. בכניסה הראשונה אחרי הפסקה זה יכול לקחת עד חצי דקה.</p>` : \"\"}\n  </div>\n  <div class=\"panel\">\n    <h2>החוקים בקצרה</h2>\n    <ul class=\"rules\">\n      <li>2–4 שחקנים, חפיסה אחת בלי ג'וקרים.</li>\n      <li>2–3 שחקנים: 12 קלפים לכל אחד, 4 לכל לוח. 4 שחקנים: 9 קלפים, 3 לכל לוח.</li>\n      <li>שלושה לוחות: הפלופ גלוי, הטרן והריבר נחשפים אחרי שכולם נעלו.</li>\n      <li>לפני החלוקה בוחרים כמה שמים על כל לוח (₪5, ₪10, ₪15, ₪25 ומעלה), וכל שחקן שם את הסכום הזה על כל אחד משלושת הלוחות.</li>\n      <li>המנצח בלוח לוקח את כל הקופה שלו, ובתיקו מחלקים.</li>\n      <li>לפי אומהה: בדיוק 2 קלפים מהיד ו־3 מהלוח.</li>\n      <li>מי שזוכה בשלושת הלוחות לבד מקבל מכל שחקן עוד סכום הימור אחד.</li>\n    </ul>\n  </div>`;\n}\n\nfunction balancesHTML(net) {\n  const st = S.stake, n = S.seats.length || 2;\n  return `<div class=\"stakeline\"><span>הימור <b>${money(st)}</b> לכל לוח</span><span>${money(st * 3)} ליד · קופה ${money(st * n)} בכל לוח</span></div>\n  <div class=\"players\">${S.seats.map(id => {\n    const p = player(id) || { total: 0 };\n    const tot = p.total - (net ? net[id] || 0 : 0);\n    const status = S.phase !== \"play\" || S.result ? \"\" : S.locked[id] ? `<span class=\"st ok\">נעל ✓</span>` : `<span class=\"st\">מסדר…</span>`;\n    const off = p.online === false ? `<span class=\"st\">מנותק</span>` : \"\";\n    return `<div class=\"pl ${id === me() ? \"me\" : \"\"}\"><span class=\"nm\">${esc(nameOf(id))}</span><span class=\"bal ${tot > 0 ? \"pos\" : tot < 0 ? \"neg\" : \"\"}\">${tot ? fmt(tot) : money(0)}</span><span class=\"st\">${tot > 0 ? \"ברווח\" : tot < 0 ? \"בהפסד\" : \"מאוזן\"}</span>${status}${off}</div>`;\n  }).join(\"\")}</div>`;\n}\n\nfunction lobbyView() {\n  const seats = S.seats;\n  const watchers = S.players.filter(p => p.online && !seats.includes(p.id));\n  const link = location.origin + location.pathname + \"#\" + S.code;\n  return `${topBar()}\n  <div class=\"panel\">\n    <p class=\"note\" style=\"text-align:center\">שלחו לחברים את הקישור, או את הקוד שיכניסו בעמוד הפתיחה.</p>\n    <div class=\"bigcode\">${esc(S.code)}</div>\n    <p class=\"note\" style=\"text-align:center;direction:ltr;user-select:all;word-break:break-all\">${esc(link)}</p>\n    <ul class=\"seats\">\n      ${seats.map(id => `<li><span>${esc(nameOf(id))}${id === me() ? \" (את/ה)\" : \"\"}</span><span class=\"tag\">${id === S.hostId ? \"מארח\" : \"יושב\"}</span></li>`).join(\"\")}\n      ${Array.from({ length: Math.max(0, 4 - seats.length) }, () => `<li class=\"empty\"><span>מקום פנוי</span><span class=\"tag\">ממתין</span></li>`).join(\"\")}\n    </ul>\n    ${watchers.length ? `<p class=\"note\">צופים: ${watchers.map(p => esc(p.name)).join(\", \")}</p>` : \"\"}\n    <p class=\"note\">הימור: <b>${money(S.stake)}</b> לכל לוח (${money(S.stake * 3)} ליד) · ${seats.length === 4 ? \"9 קלפים לכל שחקן\" : \"12 קלפים לכל שחקן\"}</p>\n    ${isHost()\n      ? `<div class=\"row\"><div class=\"field\"><label for=\"stk2\">הימור לכל לוח</label><select id=\"stk2\">${STAKES.map(v => `<option value=\"${v}\" ${v === S.stake ? \"selected\" : \"\"}>${money(v)}</option>`).join(\"\")}</select></div>\n         <button class=\"btn\" data-act=\"deal\" ${seats.length < 2 ? \"disabled\" : \"\"}>${seats.length < 2 ? \"צריך לפחות עוד שחקן\" : \"חלוקה\"}</button></div>`\n      : `<p class=\"wait\">ממתינים שהמארח (${esc(nameOf(S.hostId))}) יחלק…</p>`}\n    ${S.round ? balancesHTML(null) : \"\"}\n    ${flash ? `<p class=\"err\">${esc(flash)}</p>` : \"\"}\n  </div>`;\n}\n\nfunction playView() {\n  const per = S.per, res = S.result, mine = seated();\n  if (res) ensureReveal(S.round);\n  else if (reveal) { clearTimeout(reveal.t); reveal = null; }\n  const done = res && !reveal;\n  const P = S.place;\n  const myHand = mine ? S.hand : [];\n  const placed = new Set(P ? P.flat() : []);\n  const locked = mine && S.locked[me()];\n  let html = topBar() + balancesHTML(res && !done ? res.net : null);\n  if (!conn) html += `<p class=\"err\">החיבור לשרת נותק. מתחברים מחדש…</p>`;\n  const offline = S.seats.filter(id => player(id)?.online === false && !S.locked[id]);\n  if (!res && offline.length) html += `<p class=\"note\">${offline.map(id => esc(nameOf(id))).join(\", \")} ${offline.length > 1 ? \"מנותקים\" : \"מנותק/ת\"}. כשיחזרו לאותו קישור הם ימשיכו מאותו מקום.${isHost() ? \" אפשר גם לבטל את היד בלי שכסף יעבור.\" : \"\"}</p>`;\n  const potTxt = `קופה ${money(S.seats.length * S.stake)}`;\n\n  S.flops.forEach((flop, b) => {\n    const B = S.boards?.[b], bd = res?.boards[b];\n    const st = res ? stageOf(b) : -1;\n    const won = bd && st >= 4 && bd.win.includes(me());\n    const armed = !res && mine && sel && !locked && P[b].length < per;\n    const pend = res && st < 4;\n    html += `<section class=\"board ${armed ? \"armed\" : \"\"} ${won ? \"won\" : \"\"} ${pend ? \"waiting\" : \"\"}\" data-bi=\"${b}\" ${armed ? `data-act=\"drop\" data-b=\"${b}\"` : \"\"}>\n      <div class=\"bh\"><h3>לוח ${b + 1}</h3><span class=\"pot\">${potTxt}${bd && st >= 4 && bd.win.length > 1 ? \" · מתחלקת\" : \"\"}</span></div>\n      <div class=\"comm\">${commHTML(flop, B, res && !pend ? 4 : 0, false)}</div>`;\n    if (!res && mine) {\n      const cards = P[b];\n      const slots = cards.map(c => cardHTML(c, { btn: locked ? \"\" : \"unplace\" })).join(\"\") + Array.from({ length: per - cards.length }, slotHTML).join(\"\");\n      let cur;\n      if (cards.length >= 2) cur = `עם הפלופ: <b>${O.handName(O.bestOmaha(cards, flop))}</b>`;\n      else cur = sel && !locked && cards.length < per ? \"הקישו כאן כדי להניח את הקלף\" : `${per} קלפים ללוח הזה`;\n      html += `<div class=\"mine-wrap\"><div class=\"mine\" ${armed ? `data-act=\"drop\" data-b=\"${b}\"` : \"\"}>${slots}</div><div class=\"cur\">${cur}</div></div>`;\n    }\n    if (res && st >= 4) html += rowsHTML(bd, B, 4, false);\n    html += `</section>`;\n  });\n\n  if (reveal && res) {\n    const b = reveal.b, st = reveal.stage, B = S.boards[b], bd = res.boards[b];\n    const key = `${S.round}:${b}:${st}`, anim = key !== lastSpotKey;\n    lastSpotKey = key;\n    const winTxt = st >= 3 ? (bd.win.length > 1 ? \"תיקו · הקופה מתחלקת\" : `${esc(nameOf(bd.win[0]))} לוקח/ת את הלוח`) : STAGE_TXT[st];\n    html += `<div class=\"spot-back\"></div>\n    <section class=\"board spot ${anim && st === 0 ? \"enter\" : \"\"}\" role=\"dialog\" aria-label=\"חשיפת לוח ${b + 1}\">\n      <div class=\"bh\"><h3>לוח ${b + 1} מתוך 3</h3><span class=\"pot\">${potTxt}</span></div>\n      <div class=\"comm\">${commHTML(B.flop, B, st, anim)}</div>\n      <div class=\"stage\" aria-live=\"polite\">${winTxt}</div>\n      ${rowsHTML(bd, B, st, anim)}\n      <button class=\"ghost skip\" data-act=\"skip\">דילוג לתוצאות</button>\n    </section>`;\n  }\n\n  if (done) {\n    html += `<div class=\"summary\"><h3>סיכום היד</h3>\n      ${res.scoop ? `<div class=\"scoop\">${esc(nameOf(res.scoop))} לקח/ה את שלושת הלוחות!<br><span class=\"note\">כל שחקן משלם עוד ${money(S.stake)}</span></div>` : \"\"}\n      <ul class=\"nets\">${S.seats.map(id => `<li><span>${esc(nameOf(id))}</span><span class=\"${res.net[id] > 0 ? \"pos\" : res.net[id] < 0 ? \"neg\" : \"\"}\">${fmt(res.net[id])}</span></li>`).join(\"\")}</ul>\n      ${isHost()\n        ? `<div class=\"actions\"><button class=\"btn\" data-act=\"deal\">יד הבאה</button>${S.practice ? `<button class=\"btn alt\" data-act=\"leave\">סיום תרגול</button>` : `<button class=\"btn alt\" data-act=\"lobby\">ללובי</button>`}</div>`\n        : `<p class=\"wait\">ממתינים שהמארח יחלק יד חדשה…</p>`}\n    </div>`;\n  }\n\n  if (!res && mine) {\n    const left = myHand.length - placed.size;\n    const full = P.every(x => x.length === per);\n    const cols = myHand.length === 9 ? 5 : 6;\n    html += `<div class=\"tray\">\n      <div class=\"trayhead\"><span class=\"hint\">${locked ? \"נעלת. ממתינים לשאר השחקנים…\" : left ? `גררו קלף ללוח, או הקישו על קלף ואז על לוח · נשארו ${left}` : \"הכול מונח. אפשר לנעול.\"}</span>\n        <button class=\"ghost\" data-act=\"sort\">מיון לפי ${sortBy === \"rank\" ? \"צורה\" : \"ערך\"}</button></div>\n      ${locked ? \"\" : `<div class=\"hand\" style=\"grid-template-columns:repeat(${cols},minmax(0,1fr))\">${sortCards(myHand).map(c => cardHTML(c, { btn: \"pick\", cls: (placed.has(c) ? \"placed \" : \"\") + (sel === c ? \"sel\" : \"\") })).join(\"\")}</div>`}\n      <div class=\"actions\">${locked\n        ? `<button class=\"btn alt\" data-act=\"unlock\">ביטול נעילה</button>`\n        : `<button class=\"btn alt\" data-act=\"clear\" ${placed.size ? \"\" : \"disabled\"}>החזרת הכול</button><button class=\"btn\" data-act=\"lock\" ${full ? \"\" : \"disabled\"}>נעילה</button>`}</div>\n      ${isHost() && !S.practice && offline.length ? `<button class=\"ghost\" data-act=\"lobby\" style=\"align-self:center\">ביטול היד וחזרה ללובי</button>` : \"\"}\n    </div>`;\n  } else if (!res && !mine) {\n    html += `<p class=\"wait\">את/ה צופה ביד הזו. ביד הבאה מהלובי אפשר להצטרף.</p>`;\n    if (isHost()) html += `<button class=\"ghost\" data-act=\"lobby\" style=\"align-self:center\">ביטול היד וחזרה ללובי</button>`;\n  }\n  return html;\n}\n\n/* ---------- drawing ---------- */\nlet raf = 0;\nfunction render() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; draw(); }); }\nfunction draw() {\n  const app = $(\"#app\");\n  if (!S) {\n    const keep = { nm: $(\"#nm\")?.value, jc: $(\"#jc\")?.value, stk: $(\"#stk\")?.value, nb: $(\"#nb\")?.value };\n    const focused = document.activeElement?.id;\n    app.innerHTML = pendingJoin && conn ? topBar() + `<div class=\"panel\"><p class=\"wait\">חוזרים לשולחן ${esc(pendingJoin)}…</p></div>` : entryView();\n    for (const k in keep) if (keep[k] != null && $(\"#\" + k)) $(\"#\" + k).value = keep[k];\n    if (focused && $(\"#\" + focused)) $(\"#\" + focused).focus();\n    return;\n  }\n  app.innerHTML = S.phase === \"play\" && S.flops ? playView() : lobbyView();\n}\n\n/* ---------- moves ---------- */\nfunction setPlace(b) { S.place = b; send({ type: \"place\", b, seq: ++placeSeq }); render(); }\n\ndocument.addEventListener(\"click\", e => {\n  if (suppressClick) { suppressClick = false; return; }\n  const t = e.target.closest(\"[data-act]\"); if (!t) return;\n  const act = t.dataset.act;\n  const takeName = () => {\n    const nm = ($(\"#nm\")?.value || \"\").trim().slice(0, 24);\n    if (!nm) { flash = \"כתבו כינוי לפני שנכנסים לשולחן.\"; draw(); return false; }\n    myName = nm; store.set(\"t3o:name\", nm); return true;\n  };\n  switch (act) {\n    case \"create\": if (takeName()) send({ type: \"create\", name: myName, stake: +$(\"#stk\").value }); return;\n    case \"solo\": if (takeName()) send({ type: \"create\", name: myName, stake: +$(\"#stk\").value, practice: true, bots: +$(\"#nb\").value }); return;\n    case \"join\": {\n      if (!takeName()) return;\n      const c = ($(\"#jc\")?.value || \"\").trim().toUpperCase();\n      if (!/^[A-Z0-9]{4}$/.test(c)) { flash = \"הקוד הוא 4 תווים, למשל K7QM.\"; draw(); return; }\n      pendingJoin = c; send({ type: \"join\", code: c, name: myName }); render(); return;\n    }\n    case \"copy\": {\n      const link = location.origin + location.pathname + \"#\" + S.code;\n      const done = () => { t.textContent = \"הועתק\"; setTimeout(() => (t.textContent = \"העתקת קישור\"), 1400); };\n      try { navigator.clipboard.writeText(link).then(done, () => {}); } catch {}\n      return;\n    }\n    case \"leave\":\n      send({ type: \"leave\" }); S = null; pendingJoin = null; sel = null; store.del(\"t3o:code\");\n      history.replaceState(null, \"\", location.pathname); render(); return;\n    case \"skip\": skipReveal(); return;\n    case \"deal\": send({ type: \"deal\" }); return;\n    case \"lobby\": send({ type: \"lobby\" }); return;\n    case \"sort\": sortBy = sortBy === \"rank\" ? \"suit\" : \"rank\"; render(); return;\n  }\n  if (!seated() || S.result) return;\n  const P = S.place, per = S.per, locked = S.locked[me()];\n  if (act === \"pick\" && !locked) {\n    const c = t.dataset.c;\n    if (P.flat().includes(c)) return;\n    sel = sel === c ? null : c; render(); return;\n  }\n  if (act === \"drop\" && sel && !locked) {\n    const b = +t.dataset.b;\n    if (P[b].length < per && !P.flat().includes(sel)) { const nb = P.map(x => [...x]); nb[b].push(sel); sel = null; setPlace(nb); }\n    return;\n  }\n  if (act === \"unplace\" && !locked) { const c = t.dataset.c; setPlace(P.map(x => x.filter(y => y !== c))); return; }\n  if (act === \"clear\" && !locked) { sel = null; setPlace([[], [], []]); return; }\n  if (act === \"lock\" && P.every(x => x.length === per)) { sel = null; send({ type: \"lock\" }); return; }\n  if (act === \"unlock\") { send({ type: \"unlock\" }); return; }\n});\ndocument.addEventListener(\"change\", e => {\n  if (e.target.id === \"stk2\" && isHost()) send({ type: \"stake\", stake: +e.target.value });\n});\ndocument.addEventListener(\"keydown\", e => {\n  if (e.key === \"Enter\" && e.target.id === \"jc\") $(\"[data-act=join]\")?.click();\n});\n\n/* drag a card from the hand onto a board (mouse and touch) */\nlet drag = null, suppressClick = false;\nfunction boardAt(x, y) { const el = document.elementFromPoint(x, y)?.closest?.(\".board[data-bi]:not(.spot)\"); return el ? { el, b: +el.dataset.bi } : null; }\nfunction endDrag(e, drop) {\n  const d = drag; drag = null;\n  if (!d || !d.on) return;\n  d.ghost.remove();\n  document.querySelectorAll(\".board.over\").forEach(el => el.classList.remove(\"over\"));\n  suppressClick = true; setTimeout(() => (suppressClick = false), 0); // swallow only the click this drag produces\n  sel = null;\n  const tgt = drop && e ? boardAt(e.clientX, e.clientY) : null;\n  if (tgt && seated() && !S.result && !S.locked[me()]) {\n    const P = S.place;\n    if (P[tgt.b].length < S.per && !P.flat().includes(d.c)) { const nb = P.map(x => [...x]); nb[tgt.b].push(d.c); setPlace(nb); return; }\n  }\n  render();\n}\ndocument.addEventListener(\"pointerdown\", e => {\n  const t = e.target.closest('.hand [data-act=\"pick\"]');\n  if (!t || !seated() || S.locked[me()] || (e.pointerType === \"mouse\" && e.button !== 0)) return;\n  drag = { c: t.dataset.c, x: e.clientX, y: e.clientY, on: false, ghost: null, id: e.pointerId };\n});\ndocument.addEventListener(\"pointermove\", e => {\n  if (!drag || e.pointerId !== drag.id) return;\n  if (!drag.on) {\n    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;\n    drag.on = true; sel = drag.c;\n    const g = document.createElement(\"div\"); g.className = \"ghost-card\"; g.innerHTML = cardHTML(drag.c);\n    document.body.appendChild(g); drag.ghost = g; render();\n  }\n  drag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;\n  const over = boardAt(e.clientX, e.clientY);\n  document.querySelectorAll(\".board.over\").forEach(el => { if (el !== over?.el) el.classList.remove(\"over\"); });\n  over?.el.classList.add(\"over\");\n  e.preventDefault();\n}, { passive: false });\ndocument.addEventListener(\"pointerup\", e => { if (drag && e.pointerId === drag.id) endDrag(e, true); });\ndocument.addEventListener(\"pointercancel\", e => { if (drag && e.pointerId === drag.id) endDrag(e, false); });\n\nrender();\nconnect();\n})();\n" },
  "/omaha.js": { type: MIME[path.extname("omaha.js")], body: "/* Mazmez rules engine, shared by the server (Node) and the browser. */\n(function (root) {\n  \"use strict\";\n  const RANKS = \"23456789TJQKA\", SUITS = \"shdc\";\n  const rv = c => RANKS.indexOf(c[0]) + 2;\n  const HAND_NAMES = [\"קלף גבוה\", \"זוג\", \"שני זוגות\", \"שלישייה\", \"סטרייט\", \"פלאש\", \"פול האוס\", \"רביעייה\", \"סטרייט פלאש\"];\n  const handName = e => (e.cat === 8 && e.high === 14 ? \"רויאל פלאש\" : HAND_NAMES[e.cat]);\n\n  function fullDeck() { const d = []; for (const r of RANKS) for (const s of SUITS) d.push(r + s); return d; }\n\n  function eval5(cs) {\n    const r = cs.map(rv).sort((a, b) => b - a);\n    const flush = cs.every(c => c[1] === cs[0][1]);\n    const cnt = {}; r.forEach(x => (cnt[x] = (cnt[x] || 0) + 1));\n    const g = Object.entries(cnt).map(([k, v]) => [+k, v]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);\n    let sh = 0;\n    if (g.length === 5) { if (r[0] - r[4] === 4) sh = r[0]; else if (r[0] === 14 && r[1] === 5) sh = 5; }\n    let cat, k;\n    if (sh && flush) { cat = 8; k = [sh]; }\n    else if (g[0][1] === 4) { cat = 7; k = [g[0][0], g[1][0]]; }\n    else if (g[0][1] === 3 && g[1][1] === 2) { cat = 6; k = [g[0][0], g[1][0]]; }\n    else if (flush) { cat = 5; k = r; }\n    else if (sh) { cat = 4; k = [sh]; }\n    else if (g[0][1] === 3) { cat = 3; k = g.map(x => x[0]); }\n    else if (g[0][1] === 2 && g[1][1] === 2) { cat = 2; k = g.map(x => x[0]); }\n    else if (g[0][1] === 2) { cat = 1; k = g.map(x => x[0]); }\n    else { cat = 0; k = r; }\n    let s = cat; for (let i = 0; i < 5; i++) s = s * 15 + (k[i] || 0);\n    return { s, cat, high: k[0] };\n  }\n\n  // Omaha: exactly two hole cards and exactly three board cards\n  function bestOmaha(hole, board) {\n    let best = null;\n    for (let i = 0; i < hole.length; i++) for (let j = i + 1; j < hole.length; j++)\n      for (let a = 0; a < board.length; a++) for (let b = a + 1; b < board.length; b++) for (let c = b + 1; c < board.length; c++) {\n        const e = eval5([hole[i], hole[j], board[a], board[b], board[c]]);\n        if (!best || e.s > best.s) best = { ...e, used: [hole[i], hole[j], board[a], board[b], board[c]] };\n      }\n    return best;\n  }\n\n  function validPlace(hand, per, pl) {\n    if (!hand || !Array.isArray(pl) || pl.length !== 3) return false;\n    const seen = new Set();\n    for (const b of pl) {\n      if (!Array.isArray(b) || b.length !== per) return false;\n      for (const c of b) { if (!hand.includes(c) || seen.has(c)) return false; seen.add(c); }\n    }\n    return true;\n  }\n\n  /* Each seated player puts `stake` on every board. The best hand takes that board's pot;\n     a tie splits it. A player who wins all three boards alone gets one more stake from everyone. */\n  function settle(seats, stake, hands, per, boards, places) {\n    const n = seats.length, net = {}, out = [];\n    seats.forEach(p => (net[p] = 0));\n    for (let b = 0; b < 3; b++) {\n      const B = boards[b], five = [...B.flop, B.turn, B.river];\n      const rows = seats.map(p => {\n        const ok = validPlace(hands[p], per, places[p]);\n        const e = ok ? bestOmaha(places[p][b], five) : null;\n        return { p, ok, hole: ok ? places[p][b] : [], s: e ? e.s : -1 };\n      });\n      const live = rows.filter(x => x.ok);\n      if (!live.length) { out.push({ rows, win: [], pot: 0 }); continue; }\n      const top = Math.max(...live.map(x => x.s));\n      const win = live.filter(x => x.s === top).map(x => x.p);\n      const pot = n * stake, share = pot / win.length;\n      rows.forEach(x => { net[x.p] -= stake; if (win.includes(x.p)) net[x.p] += share; });\n      out.push({ rows, win, pot });\n    }\n    const w0 = out[0].win;\n    const scoop = w0.length === 1 && out.every(bd => bd.win.length === 1 && bd.win[0] === w0[0]) ? w0[0] : null;\n    if (scoop) seats.forEach(p => { if (p !== scoop) { net[p] -= stake; net[scoop] += stake; } });\n    for (const p in net) net[p] = Math.round(net[p] * 100) / 100;\n    return { boards: out, net, scoop };\n  }\n\n  // Computer player: tries many splits and keeps the strongest one against the three flops\n  function botArrange(hand, per, flops, rand) {\n    rand = rand || Math.random;\n    let best = null, bestScore = -1;\n    for (let t = 0; t < 400; t++) {\n      const h = [...hand];\n      for (let i = h.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [h[i], h[j]] = [h[j], h[i]]; }\n      const split = [h.slice(0, per), h.slice(per, 2 * per), h.slice(2 * per, 3 * per)];\n      let sc = 0;\n      split.forEach((cs, b) => { const e = bestOmaha(cs, flops[b]); sc += e.cat * 1e3 + e.high * 10 + cs.reduce((a, c) => a + rv(c), 0) / 10; });\n      if (sc > bestScore) { bestScore = sc; best = split; }\n    }\n    return best;\n  }\n\n  const api = { RANKS, SUITS, rv, handName, fullDeck, eval5, bestOmaha, validPlace, settle, botArrange };\n  if (typeof module !== \"undefined\" && module.exports) module.exports = api;\n  else root.Omaha = api;\n})(typeof self !== \"undefined\" ? self : this);\n" },
  "/icon.svg": { type: MIME[path.extname("icon.svg")], body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"14\" fill=\"#2b1216\"/><rect x=\"14\" y=\"10\" width=\"30\" height=\"42\" rx=\"5\" fill=\"#f5efe2\" transform=\"rotate(-10 29 31)\"/><rect x=\"22\" y=\"12\" width=\"30\" height=\"42\" rx=\"5\" fill=\"#f5efe2\" stroke=\"#d6ad5c\" stroke-width=\"2\"/><text x=\"37\" y=\"42\" font-family=\"Georgia,serif\" font-size=\"24\" font-weight=\"700\" fill=\"#b5202d\" text-anchor=\"middle\">♥</text></svg>" }
};

/* ---------- static files ---------- */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  if (p === "/") p = "/index.html";
  const f = FILES[p];
  if (!f) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("לא נמצא"); }
  res.writeHead(200, { "Content-Type": f.type, "Cache-Control": "no-cache" });
  res.end(f.body);
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
