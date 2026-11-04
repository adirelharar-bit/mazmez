/* Mazmez rules engine, shared by the server (Node) and the browser. */
(function (root) {
  "use strict";
  const RANKS = "23456789TJQKA", SUITS = "shdc";
  const rv = c => RANKS.indexOf(c[0]) + 2;
  const HAND_NAMES = ["קלף גבוה", "זוג", "שני זוגות", "שלישייה", "סטרייט", "פלאש", "פול האוס", "רביעייה", "סטרייט פלאש"];
  const handName = e => (e.cat === 8 && e.high === 14 ? "רויאל פלאש" : HAND_NAMES[e.cat]);

  function fullDeck() { const d = []; for (const r of RANKS) for (const s of SUITS) d.push(r + s); return d; }

  function eval5(cs) {
    const r = cs.map(rv).sort((a, b) => b - a);
    const flush = cs.every(c => c[1] === cs[0][1]);
    const cnt = {}; r.forEach(x => (cnt[x] = (cnt[x] || 0) + 1));
    const g = Object.entries(cnt).map(([k, v]) => [+k, v]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    let sh = 0;
    if (g.length === 5) { if (r[0] - r[4] === 4) sh = r[0]; else if (r[0] === 14 && r[1] === 5) sh = 5; }
    let cat, k;
    if (sh && flush) { cat = 8; k = [sh]; }
    else if (g[0][1] === 4) { cat = 7; k = [g[0][0], g[1][0]]; }
    else if (g[0][1] === 3 && g[1][1] === 2) { cat = 6; k = [g[0][0], g[1][0]]; }
    else if (flush) { cat = 5; k = r; }
    else if (sh) { cat = 4; k = [sh]; }
    else if (g[0][1] === 3) { cat = 3; k = g.map(x => x[0]); }
    else if (g[0][1] === 2 && g[1][1] === 2) { cat = 2; k = g.map(x => x[0]); }
    else if (g[0][1] === 2) { cat = 1; k = g.map(x => x[0]); }
    else { cat = 0; k = r; }
    let s = cat; for (let i = 0; i < 5; i++) s = s * 15 + (k[i] || 0);
    return { s, cat, high: k[0] };
  }

  // Omaha: exactly two hole cards and exactly three board cards
  function bestOmaha(hole, board) {
    let best = null;
    for (let i = 0; i < hole.length; i++) for (let j = i + 1; j < hole.length; j++)
      for (let a = 0; a < board.length; a++) for (let b = a + 1; b < board.length; b++) for (let c = b + 1; c < board.length; c++) {
        const e = eval5([hole[i], hole[j], board[a], board[b], board[c]]);
        if (!best || e.s > best.s) best = { ...e, used: [hole[i], hole[j], board[a], board[b], board[c]] };
      }
    return best;
  }

  function validPlace(hand, per, pl) {
    if (!hand || !Array.isArray(pl) || pl.length !== 3) return false;
    const seen = new Set();
    for (const b of pl) {
      if (!Array.isArray(b) || b.length !== per) return false;
      for (const c of b) { if (!hand.includes(c) || seen.has(c)) return false; seen.add(c); }
    }
    return true;
  }

  /* Each seated player puts `stake` on every board. The best hand takes that board's pot;
     a tie splits it. A player who wins all three boards alone gets one more stake from everyone. */
  function settle(seats, stake, hands, per, boards, places) {
    const n = seats.length, net = {}, out = [];
    seats.forEach(p => (net[p] = 0));
    for (let b = 0; b < 3; b++) {
      const B = boards[b], five = [...B.flop, B.turn, B.river];
      const rows = seats.map(p => {
        const ok = validPlace(hands[p], per, places[p]);
        const e = ok ? bestOmaha(places[p][b], five) : null;
        return { p, ok, hole: ok ? places[p][b] : [], s: e ? e.s : -1 };
      });
      const live = rows.filter(x => x.ok);
      if (!live.length) { out.push({ rows, win: [], pot: 0 }); continue; }
      const top = Math.max(...live.map(x => x.s));
      const win = live.filter(x => x.s === top).map(x => x.p);
      const pot = n * stake, share = pot / win.length;
      rows.forEach(x => { net[x.p] -= stake; if (win.includes(x.p)) net[x.p] += share; });
      out.push({ rows, win, pot });
    }
    const w0 = out[0].win;
    const scoop = w0.length === 1 && out.every(bd => bd.win.length === 1 && bd.win[0] === w0[0]) ? w0[0] : null;
    if (scoop) seats.forEach(p => { if (p !== scoop) { net[p] -= stake; net[scoop] += stake; } });
    for (const p in net) net[p] = Math.round(net[p] * 100) / 100;
    return { boards: out, net, scoop };
  }

  // Computer player: tries many splits and keeps the strongest one against the three flops
  function botArrange(hand, per, flops, rand) {
    rand = rand || Math.random;
    let best = null, bestScore = -1;
    for (let t = 0; t < 400; t++) {
      const h = [...hand];
      for (let i = h.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [h[i], h[j]] = [h[j], h[i]]; }
      const split = [h.slice(0, per), h.slice(per, 2 * per), h.slice(2 * per, 3 * per)];
      let sc = 0;
      split.forEach((cs, b) => { const e = bestOmaha(cs, flops[b]); sc += e.cat * 1e3 + e.high * 10 + cs.reduce((a, c) => a + rv(c), 0) / 10; });
      if (sc > bestScore) { bestScore = sc; best = split; }
    }
    return best;
  }

  const api = { RANKS, SUITS, rv, handName, fullDeck, eval5, bestOmaha, validPlace, settle, botArrange };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Omaha = api;
})(typeof self !== "undefined" ? self : this);
