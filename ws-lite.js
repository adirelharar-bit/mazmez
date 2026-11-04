/* A small WebSocket server (RFC 6455) with no dependencies: text messages, ping/pong and close.
   Enough for the game, and nothing to install. */
"use strict";
const crypto = require("crypto");
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

module.exports = { WebSocketServer };
