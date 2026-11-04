/* Mazmez client: draws what the server sends and sends back the player's moves. */
(() => {
"use strict";
const O = window.Omaha;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const SYM = { s: "♠", h: "♥", d: "♦", c: "♣" };
const STAKES = [5, 10, 15, 25, 50, 100];
const money = x => "₪" + (Math.round(Math.abs(x) * 100) / 100).toLocaleString("he-IL", { maximumFractionDigits: 2 });
// wrapped in a left-to-right isolate so "+₪10" keeps its order inside Hebrew text
const fmt = x => { const v = Math.round(x * 100) / 100; return "\u2066" + (v > 0 ? "+" : v < 0 ? "−" : "") + money(v) + "\u2069"; };

/* ---------- identity ---------- */
let token = store.get("t3o:token");
if (!token) { token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""); store.set("t3o:token", token); }
let myName = store.get("t3o:name") || "";
const linkCode = (location.hash.match(/^#([A-Za-z0-9]{4})$/) || [])[1]?.toUpperCase() || "";

/* ---------- connection ---------- */
let ws = null, conn = false, S = null, flash = "", retry = 0, pendingJoin = store.get("t3o:code");
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onopen = () => {
    conn = true; retry = 0;
    const code = S?.code || pendingJoin;
    if (code) send({ type: "join", code, name: myName });
    render();
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "state") {
      if (S && S.round !== m.round) { sel = null; placeSeq = 0; }
      // keep my newest arrangement if this message answers an older move of mine
      else if (S && S.place && m.place && (m.placeSeq || 0) < placeSeq) m.place = S.place;
      S = m; pendingJoin = null; flash = "";
      store.set("t3o:code", m.code);
      if (!m.practice && location.hash !== "#" + m.code) history.replaceState(null, "", "#" + m.code);
    } else if (m.type === "error") {
      flash = m.msg;
      if (m.gone) { S = null; pendingJoin = null; store.del("t3o:code"); }
    }
    render();
  };
  ws.onclose = () => {
    conn = false; render();
    setTimeout(connect, Math.min(8000, 600 * 2 ** retry++));
  };
}
function send(m) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ token, ...m })); return true; } return false; }

/* ---------- local view state ---------- */
let sel = null, sortBy = "rank", placeSeq = 0;
const me = () => S?.you;
const isHost = () => S && S.hostId === S.you;
const nameOf = id => S?.players.find(p => p.id === id)?.name || "שחקן";
const player = id => S?.players.find(p => p.id === id);
const seated = () => S && S.phase === "play" && S.seats.includes(S.you);

/* ---------- cards ---------- */
function cardHTML(c, o = {}) {
  if (!c) return `<span class="card back ${o.mini ? "mini" : ""} ${o.cls || ""}" aria-label="קלף סגור"></span>`;
  const tag = o.btn ? "button" : "span";
  const r = c[0] === "T" ? "10" : c[0];
  return `<${tag} class="card su-${c[1]} ${o.mini ? "mini" : ""} ${o.cls || ""}" ${o.btn ? `type="button" data-act="${o.btn}" data-c="${c}"` : ""} aria-label="${r}${SYM[c[1]]}"><span class="r">${r}</span><span class="s">${SYM[c[1]]}</span></${tag}>`;
}
const slotHTML = () => `<span class="card slot"></span>`;
const sortCards = cs => [...cs].sort(sortBy === "rank"
  ? (a, b) => O.rv(b) - O.rv(a) || O.SUITS.indexOf(a[1]) - O.SUITS.indexOf(b[1])
  : (a, b) => O.SUITS.indexOf(a[1]) - O.SUITS.indexOf(b[1]) || O.rv(b) - O.rv(a));

/* ---------- staged reveal: one board at a time ---------- */
let reveal = null, revealedRound = 0, lastSpotKey = "";
const STEP_MS = [1500, 1900, 1700, 2400]; // look at the hands, turn, river, winner
const STAGE_TXT = ["הקלפים על השולחן…", "הטרן…", "הריבר…", ""];
function ensureReveal(round) {
  if (revealedRound === round || (reveal && reveal.round === round)) return;
  if (reveal) clearTimeout(reveal.t);
  reveal = { round, b: 0, stage: 0 }; lastSpotKey = ""; scheduleReveal();
}
function scheduleReveal() { clearTimeout(reveal.t); reveal.t = setTimeout(stepReveal, STEP_MS[reveal.stage]); }
function stepReveal() {
  if (!reveal) return;
  reveal.stage++;
  if (reveal.stage > 3) { reveal.b++; reveal.stage = 0; }
  if (reveal.b > 2) { revealedRound = reveal.round; reveal = null; render(); return; }
  scheduleReveal(); render();
}
function skipReveal() { if (reveal) { clearTimeout(reveal.t); revealedRound = reveal.round; reveal = null; render(); } }
const stageOf = b => (!reveal ? 4 : b < reveal.b ? 4 : b === reveal.b ? reveal.stage : -1);

function knownBoard(B, st) { return [...B.flop, ...(st >= 1 ? [B.turn] : []), ...(st >= 2 ? [B.river] : [])]; }
function commHTML(flop, B, st, anim) {
  return flop.map(c => cardHTML(c)).join("") + `<span class="gap"></span>` +
    (B && st >= 1 ? cardHTML(B.turn, { cls: anim && st === 1 ? "flip" : "" }) : cardHTML(null)) +
    (B && st >= 2 ? cardHTML(B.river, { cls: anim && st === 2 ? "flip" : "" }) : cardHTML(null));
}
function rowsHTML(bd, B, st, anim) {
  const final = st >= 3, known = knownBoard(B, st);
  const evals = bd.rows.map(x => (x.ok ? O.bestOmaha(x.hole, known) : null));
  const live = evals.filter(Boolean);
  const top = live.length ? Math.max(...live.map(e => e.s)) : null;
  return `<div class="res">${bd.rows.map((x, i) => {
    const e = evals[i];
    const w = final ? bd.win.includes(x.p) : e && e.s === top;
    const used = new Set(final && e ? e.used : []);
    const cs = x.ok ? x.hole.map(c => cardHTML(c, { mini: true, cls: final ? (used.has(c) ? "use" : "dim") : "" })).join("") : "";
    const share = final && w ? ` · ${fmt(bd.pot / bd.win.length)}` : "";
    const cls = w ? (final ? `win ${anim ? "pop" : ""}` : "lead") : "";
    return `<div class="rr ${cls}"><span class="who">${final && w ? "★ " : ""}${esc(nameOf(x.p))}</span><span class="hn">${x.ok ? O.handName(e) + share : "סידור לא תקין"}</span><div class="cs">${cs}</div></div>`;
  }).join("")}</div>`;
}

/* ---------- views ---------- */
function topBar() {
  let chip = "";
  if (S) chip = `<div class="codechip">${S.practice ? `<b style="letter-spacing:0">משחק תרגול</b>`
      : `<span class="dot ${conn ? "on" : ""}" title="${conn ? "מחובר" : "מתחבר…"}"></span><b>${esc(S.code)}</b><button class="ghost" data-act="copy">העתקת קישור</button>`}<button class="ghost" data-act="leave">יציאה</button></div>`;
  else if (!conn) chip = `<div class="codechip"><span class="dot"></span><span class="note">מתחברים לשרת…</span></div>`;
  return `<div class="top"><div class="brand">mazmez<small>שלושה לוחות · שני קלפים בדיוק</small></div>${chip}</div>`;
}

function entryView() {
  const stakeOpts = STAKES.map(v => `<option value="${v}">${money(v)} לכל לוח</option>`).join("");
  return `${topBar()}
  <div class="panel">
    <h2>מי משחק?</h2>
    <div class="field"><label for="nm">הכינוי שלך ליד השולחן</label><input id="nm" maxlength="24" value="${esc(myName)}" placeholder="למשל: אדיר" autocomplete="nickname"></div>
    <div class="row">
      <div class="field"><label for="jc">קוד שולחן שקיבלת</label><input id="jc" class="code" maxlength="4" placeholder="ABCD" autocomplete="off" value="${esc(linkCode)}"></div>
      <button class="btn ${linkCode ? "" : "alt"}" data-act="join" ${conn ? "" : "disabled"}>הצטרפות</button>
    </div>
    <div class="row">
      <div class="field"><label for="stk">או לפתוח שולחן חדש · הימור</label><select id="stk">${stakeOpts}</select></div>
      <button class="btn ${linkCode ? "alt" : ""}" data-act="create" ${conn ? "" : "disabled"}>פתיחת שולחן</button>
    </div>
    <div class="row">
      <div class="field"><label for="nb">או לשחק לבד מול המחשב</label>
        <select id="nb"><option value="1">מול מחשב אחד</option><option value="2">מול שני מחשבים</option><option value="3">מול שלושה מחשבים (9 קלפים)</option></select></div>
      <button class="btn alt" data-act="solo" ${conn ? "" : "disabled"}>משחק תרגול</button>
    </div>
    ${flash ? `<p class="err">${esc(flash)}</p>` : ""}
    ${!conn ? `<p class="note">מתחברים לשרת. בכניסה הראשונה אחרי הפסקה זה יכול לקחת עד חצי דקה.</p>` : ""}
  </div>
  <div class="panel">
    <h2>החוקים בקצרה</h2>
    <ul class="rules">
      <li>2–4 שחקנים, חפיסה אחת בלי ג'וקרים.</li>
      <li>2–3 שחקנים: 12 קלפים לכל אחד, 4 לכל לוח. 4 שחקנים: 9 קלפים, 3 לכל לוח.</li>
      <li>שלושה לוחות: הפלופ גלוי, הטרן והריבר נחשפים אחרי שכולם נעלו.</li>
      <li>לפני החלוקה בוחרים כמה שמים על כל לוח (₪5, ₪10, ₪15, ₪25 ומעלה), וכל שחקן שם את הסכום הזה על כל אחד משלושת הלוחות.</li>
      <li>המנצח בלוח לוקח את כל הקופה שלו, ובתיקו מחלקים.</li>
      <li>לפי אומהה: בדיוק 2 קלפים מהיד ו־3 מהלוח.</li>
      <li>מי שזוכה בשלושת הלוחות לבד מקבל מכל שחקן עוד סכום הימור אחד.</li>
    </ul>
  </div>`;
}

function balancesHTML(net) {
  const st = S.stake, n = S.seats.length || 2;
  return `<div class="stakeline"><span>הימור <b>${money(st)}</b> לכל לוח</span><span>${money(st * 3)} ליד · קופה ${money(st * n)} בכל לוח</span></div>
  <div class="players">${S.seats.map(id => {
    const p = player(id) || { total: 0 };
    const tot = p.total - (net ? net[id] || 0 : 0);
    const status = S.phase !== "play" || S.result ? "" : S.locked[id] ? `<span class="st ok">נעל ✓</span>` : `<span class="st">מסדר…</span>`;
    const off = p.online === false ? `<span class="st">מנותק</span>` : "";
    return `<div class="pl ${id === me() ? "me" : ""}"><span class="nm">${esc(nameOf(id))}</span><span class="bal ${tot > 0 ? "pos" : tot < 0 ? "neg" : ""}">${tot ? fmt(tot) : money(0)}</span><span class="st">${tot > 0 ? "ברווח" : tot < 0 ? "בהפסד" : "מאוזן"}</span>${status}${off}</div>`;
  }).join("")}</div>`;
}

function lobbyView() {
  const seats = S.seats;
  const watchers = S.players.filter(p => p.online && !seats.includes(p.id));
  const link = location.origin + location.pathname + "#" + S.code;
  return `${topBar()}
  <div class="panel">
    <p class="note" style="text-align:center">שלחו לחברים את הקישור, או את הקוד שיכניסו בעמוד הפתיחה.</p>
    <div class="bigcode">${esc(S.code)}</div>
    <p class="note" style="text-align:center;direction:ltr;user-select:all;word-break:break-all">${esc(link)}</p>
    <ul class="seats">
      ${seats.map(id => `<li><span>${esc(nameOf(id))}${id === me() ? " (את/ה)" : ""}</span><span class="tag">${id === S.hostId ? "מארח" : "יושב"}</span></li>`).join("")}
      ${Array.from({ length: Math.max(0, 4 - seats.length) }, () => `<li class="empty"><span>מקום פנוי</span><span class="tag">ממתין</span></li>`).join("")}
    </ul>
    ${watchers.length ? `<p class="note">צופים: ${watchers.map(p => esc(p.name)).join(", ")}</p>` : ""}
    <p class="note">הימור: <b>${money(S.stake)}</b> לכל לוח (${money(S.stake * 3)} ליד) · ${seats.length === 4 ? "9 קלפים לכל שחקן" : "12 קלפים לכל שחקן"}</p>
    ${isHost()
      ? `<div class="row"><div class="field"><label for="stk2">הימור לכל לוח</label><select id="stk2">${STAKES.map(v => `<option value="${v}" ${v === S.stake ? "selected" : ""}>${money(v)}</option>`).join("")}</select></div>
         <button class="btn" data-act="deal" ${seats.length < 2 ? "disabled" : ""}>${seats.length < 2 ? "צריך לפחות עוד שחקן" : "חלוקה"}</button></div>`
      : `<p class="wait">ממתינים שהמארח (${esc(nameOf(S.hostId))}) יחלק…</p>`}
    ${S.round ? balancesHTML(null) : ""}
    ${flash ? `<p class="err">${esc(flash)}</p>` : ""}
  </div>`;
}

function playView() {
  const per = S.per, res = S.result, mine = seated();
  if (res) ensureReveal(S.round);
  else if (reveal) { clearTimeout(reveal.t); reveal = null; }
  const done = res && !reveal;
  const P = S.place;
  const myHand = mine ? S.hand : [];
  const placed = new Set(P ? P.flat() : []);
  const locked = mine && S.locked[me()];
  let html = topBar() + balancesHTML(res && !done ? res.net : null);
  if (!conn) html += `<p class="err">החיבור לשרת נותק. מתחברים מחדש…</p>`;
  const offline = S.seats.filter(id => player(id)?.online === false && !S.locked[id]);
  if (!res && offline.length) html += `<p class="note">${offline.map(id => esc(nameOf(id))).join(", ")} ${offline.length > 1 ? "מנותקים" : "מנותק/ת"}. כשיחזרו לאותו קישור הם ימשיכו מאותו מקום.${isHost() ? " אפשר גם לבטל את היד בלי שכסף יעבור." : ""}</p>`;
  const potTxt = `קופה ${money(S.seats.length * S.stake)}`;

  S.flops.forEach((flop, b) => {
    const B = S.boards?.[b], bd = res?.boards[b];
    const st = res ? stageOf(b) : -1;
    const won = bd && st >= 4 && bd.win.includes(me());
    const armed = !res && mine && sel && !locked && P[b].length < per;
    const pend = res && st < 4;
    html += `<section class="board ${armed ? "armed" : ""} ${won ? "won" : ""} ${pend ? "waiting" : ""}" data-bi="${b}" ${armed ? `data-act="drop" data-b="${b}"` : ""}>
      <div class="bh"><h3>לוח ${b + 1}</h3><span class="pot">${potTxt}${bd && st >= 4 && bd.win.length > 1 ? " · מתחלקת" : ""}</span></div>
      <div class="comm">${commHTML(flop, B, res && !pend ? 4 : 0, false)}</div>`;
    if (!res && mine) {
      const cards = P[b];
      const slots = cards.map(c => cardHTML(c, { btn: locked ? "" : "unplace" })).join("") + Array.from({ length: per - cards.length }, slotHTML).join("");
      let cur;
      if (cards.length >= 2) cur = `עם הפלופ: <b>${O.handName(O.bestOmaha(cards, flop))}</b>`;
      else cur = sel && !locked && cards.length < per ? "הקישו כאן כדי להניח את הקלף" : `${per} קלפים ללוח הזה`;
      html += `<div class="mine-wrap"><div class="mine" ${armed ? `data-act="drop" data-b="${b}"` : ""}>${slots}</div><div class="cur">${cur}</div></div>`;
    }
    if (res && st >= 4) html += rowsHTML(bd, B, 4, false);
    html += `</section>`;
  });

  if (reveal && res) {
    const b = reveal.b, st = reveal.stage, B = S.boards[b], bd = res.boards[b];
    const key = `${S.round}:${b}:${st}`, anim = key !== lastSpotKey;
    lastSpotKey = key;
    const winTxt = st >= 3 ? (bd.win.length > 1 ? "תיקו · הקופה מתחלקת" : `${esc(nameOf(bd.win[0]))} לוקח/ת את הלוח`) : STAGE_TXT[st];
    html += `<div class="spot-back"></div>
    <section class="board spot ${anim && st === 0 ? "enter" : ""}" role="dialog" aria-label="חשיפת לוח ${b + 1}">
      <div class="bh"><h3>לוח ${b + 1} מתוך 3</h3><span class="pot">${potTxt}</span></div>
      <div class="comm">${commHTML(B.flop, B, st, anim)}</div>
      <div class="stage" aria-live="polite">${winTxt}</div>
      ${rowsHTML(bd, B, st, anim)}
      <button class="ghost skip" data-act="skip">דילוג לתוצאות</button>
    </section>`;
  }

  if (done) {
    html += `<div class="summary"><h3>סיכום היד</h3>
      ${res.scoop ? `<div class="scoop">${esc(nameOf(res.scoop))} לקח/ה את שלושת הלוחות!<br><span class="note">כל שחקן משלם עוד ${money(S.stake)}</span></div>` : ""}
      <ul class="nets">${S.seats.map(id => `<li><span>${esc(nameOf(id))}</span><span class="${res.net[id] > 0 ? "pos" : res.net[id] < 0 ? "neg" : ""}">${fmt(res.net[id])}</span></li>`).join("")}</ul>
      ${isHost()
        ? `<div class="actions"><button class="btn" data-act="deal">יד הבאה</button>${S.practice ? `<button class="btn alt" data-act="leave">סיום תרגול</button>` : `<button class="btn alt" data-act="lobby">ללובי</button>`}</div>`
        : `<p class="wait">ממתינים שהמארח יחלק יד חדשה…</p>`}
    </div>`;
  }

  if (!res && mine) {
    const left = myHand.length - placed.size;
    const full = P.every(x => x.length === per);
    const cols = myHand.length === 9 ? 5 : 6;
    html += `<div class="tray">
      <div class="trayhead"><span class="hint">${locked ? "נעלת. ממתינים לשאר השחקנים…" : left ? `גררו קלף ללוח, או הקישו על קלף ואז על לוח · נשארו ${left}` : "הכול מונח. אפשר לנעול."}</span>
        <button class="ghost" data-act="sort">מיון לפי ${sortBy === "rank" ? "צורה" : "ערך"}</button></div>
      ${locked ? "" : `<div class="hand" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${sortCards(myHand).map(c => cardHTML(c, { btn: "pick", cls: (placed.has(c) ? "placed " : "") + (sel === c ? "sel" : "") })).join("")}</div>`}
      <div class="actions">${locked
        ? `<button class="btn alt" data-act="unlock">ביטול נעילה</button>`
        : `<button class="btn alt" data-act="clear" ${placed.size ? "" : "disabled"}>החזרת הכול</button><button class="btn" data-act="lock" ${full ? "" : "disabled"}>נעילה</button>`}</div>
      ${isHost() && !S.practice && offline.length ? `<button class="ghost" data-act="lobby" style="align-self:center">ביטול היד וחזרה ללובי</button>` : ""}
    </div>`;
  } else if (!res && !mine) {
    html += `<p class="wait">את/ה צופה ביד הזו. ביד הבאה מהלובי אפשר להצטרף.</p>`;
    if (isHost()) html += `<button class="ghost" data-act="lobby" style="align-self:center">ביטול היד וחזרה ללובי</button>`;
  }
  return html;
}

/* ---------- drawing ---------- */
let raf = 0;
function render() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
function draw() {
  const app = $("#app");
  if (!S) {
    const keep = { nm: $("#nm")?.value, jc: $("#jc")?.value, stk: $("#stk")?.value, nb: $("#nb")?.value };
    const focused = document.activeElement?.id;
    app.innerHTML = pendingJoin && conn ? topBar() + `<div class="panel"><p class="wait">חוזרים לשולחן ${esc(pendingJoin)}…</p></div>` : entryView();
    for (const k in keep) if (keep[k] != null && $("#" + k)) $("#" + k).value = keep[k];
    if (focused && $("#" + focused)) $("#" + focused).focus();
    return;
  }
  app.innerHTML = S.phase === "play" && S.flops ? playView() : lobbyView();
}

/* ---------- moves ---------- */
function setPlace(b) { S.place = b; send({ type: "place", b, seq: ++placeSeq }); render(); }

document.addEventListener("click", e => {
  if (suppressClick) { suppressClick = false; return; }
  const t = e.target.closest("[data-act]"); if (!t) return;
  const act = t.dataset.act;
  const takeName = () => {
    const nm = ($("#nm")?.value || "").trim().slice(0, 24);
    if (!nm) { flash = "כתבו כינוי לפני שנכנסים לשולחן."; draw(); return false; }
    myName = nm; store.set("t3o:name", nm); return true;
  };
  switch (act) {
    case "create": if (takeName()) send({ type: "create", name: myName, stake: +$("#stk").value }); return;
    case "solo": if (takeName()) send({ type: "create", name: myName, stake: +$("#stk").value, practice: true, bots: +$("#nb").value }); return;
    case "join": {
      if (!takeName()) return;
      const c = ($("#jc")?.value || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(c)) { flash = "הקוד הוא 4 תווים, למשל K7QM."; draw(); return; }
      pendingJoin = c; send({ type: "join", code: c, name: myName }); render(); return;
    }
    case "copy": {
      const link = location.origin + location.pathname + "#" + S.code;
      const done = () => { t.textContent = "הועתק"; setTimeout(() => (t.textContent = "העתקת קישור"), 1400); };
      try { navigator.clipboard.writeText(link).then(done, () => {}); } catch {}
      return;
    }
    case "leave":
      send({ type: "leave" }); S = null; pendingJoin = null; sel = null; store.del("t3o:code");
      history.replaceState(null, "", location.pathname); render(); return;
    case "skip": skipReveal(); return;
    case "deal": send({ type: "deal" }); return;
    case "lobby": send({ type: "lobby" }); return;
    case "sort": sortBy = sortBy === "rank" ? "suit" : "rank"; render(); return;
  }
  if (!seated() || S.result) return;
  const P = S.place, per = S.per, locked = S.locked[me()];
  if (act === "pick" && !locked) {
    const c = t.dataset.c;
    if (P.flat().includes(c)) return;
    sel = sel === c ? null : c; render(); return;
  }
  if (act === "drop" && sel && !locked) {
    const b = +t.dataset.b;
    if (P[b].length < per && !P.flat().includes(sel)) { const nb = P.map(x => [...x]); nb[b].push(sel); sel = null; setPlace(nb); }
    return;
  }
  if (act === "unplace" && !locked) { const c = t.dataset.c; setPlace(P.map(x => x.filter(y => y !== c))); return; }
  if (act === "clear" && !locked) { sel = null; setPlace([[], [], []]); return; }
  if (act === "lock" && P.every(x => x.length === per)) { sel = null; send({ type: "lock" }); return; }
  if (act === "unlock") { send({ type: "unlock" }); return; }
});
document.addEventListener("change", e => {
  if (e.target.id === "stk2" && isHost()) send({ type: "stake", stake: +e.target.value });
});
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.id === "jc") $("[data-act=join]")?.click();
});

/* drag a card from the hand onto a board (mouse and touch) */
let drag = null, suppressClick = false;
function boardAt(x, y) { const el = document.elementFromPoint(x, y)?.closest?.(".board[data-bi]:not(.spot)"); return el ? { el, b: +el.dataset.bi } : null; }
function endDrag(e, drop) {
  const d = drag; drag = null;
  if (!d || !d.on) return;
  d.ghost.remove();
  document.querySelectorAll(".board.over").forEach(el => el.classList.remove("over"));
  suppressClick = true; setTimeout(() => (suppressClick = false), 0); // swallow only the click this drag produces
  sel = null;
  const tgt = drop && e ? boardAt(e.clientX, e.clientY) : null;
  if (tgt && seated() && !S.result && !S.locked[me()]) {
    const P = S.place;
    if (P[tgt.b].length < S.per && !P.flat().includes(d.c)) { const nb = P.map(x => [...x]); nb[tgt.b].push(d.c); setPlace(nb); return; }
  }
  render();
}
document.addEventListener("pointerdown", e => {
  const t = e.target.closest('.hand [data-act="pick"]');
  if (!t || !seated() || S.locked[me()] || (e.pointerType === "mouse" && e.button !== 0)) return;
  drag = { c: t.dataset.c, x: e.clientX, y: e.clientY, on: false, ghost: null, id: e.pointerId };
});
document.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.on) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
    drag.on = true; sel = drag.c;
    const g = document.createElement("div"); g.className = "ghost-card"; g.innerHTML = cardHTML(drag.c);
    document.body.appendChild(g); drag.ghost = g; render();
  }
  drag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  const over = boardAt(e.clientX, e.clientY);
  document.querySelectorAll(".board.over").forEach(el => { if (el !== over?.el) el.classList.remove("over"); });
  over?.el.classList.add("over");
  e.preventDefault();
}, { passive: false });
document.addEventListener("pointerup", e => { if (drag && e.pointerId === drag.id) endDrag(e, true); });
document.addEventListener("pointercancel", e => { if (drag && e.pointerId === drag.id) endDrag(e, false); });

render();
connect();
})();
