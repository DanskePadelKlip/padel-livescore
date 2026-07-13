// Padel Livescore — P2 UX. Dependency-free.
// Data source: data/matches.json (produced by scripts/fetch-live.js).
// Features: Live Now section, status/country/search filters, collapsible
// tournament groups (keeps the DOM light), tap-to-expand match detail,
// auto-refresh polling with score-change flashing.

// Adaptive polling: near-real-time while a match is live, lazy when nothing's on.
const POLL_LIVE = 20_000;     // ≥1 live match  -> poll fast
const POLL_UPCOMING = 90_000; // matches upcoming -> moderate
const POLL_IDLE = 300_000;    // nothing on      -> back off (5 min)
const FLAGS = { FIP: "🌍", DK: "🇩🇰", SE: "🇸🇪", DE: "🇩🇪", CZ: "🇨🇿", NO: "🇳🇴", FI: "🇫🇮", FR: "🇫🇷", HR: "🇭🇷", EE: "🇪🇪", GE: "🇬🇪", HU: "🇭🇺", UA: "🇺🇦", SI: "🇸🇮", XK: "🇽🇰", BA: "🇧🇦", ME: "🇲🇪" };
const SOURCE_LABEL = { rankedin: "RankedIn", tournamentsoftware: "tournamentsoftware.com", fip: "padelfip.com" };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- favorites (follow players / tournaments; localStorage) ----------
// Shape: { players: { <id>: {name, extra} }, tournaments: { <key>: {name, extra} } }
// where extra = country (players) or federation (tournaments). This set is also
// exactly the future push-notification subscription list.
const FAV_KEY = "pt-favs";
function loadFavs() {
  try {
    const f = JSON.parse(localStorage.getItem(FAV_KEY)) || {};
    return { players: f.players || {}, tournaments: f.tournaments || {} };
  } catch { return { players: {}, tournaments: {} }; }
}
function saveFavs(f) { try { localStorage.setItem(FAV_KEY, JSON.stringify(f)); } catch {} }
function isFav(type, id) { return !!(state.favs[type] && state.favs[type][id]); }
function toggleFav(type, id, name, extra) {
  const bag = state.favs[type] || (state.favs[type] = {});
  if (bag[id]) delete bag[id]; else bag[id] = { name, extra: extra || "" };
  saveFavs(state.favs);
  updateFavBadge();
  syncPushFollows(); // keep push subscription's follow set in sync
}
function favCount() {
  return Object.keys(state.favs.players).length + Object.keys(state.favs.tournaments).length;
}
function updateFavBadge() {
  const el = document.getElementById("favcount");
  if (!el) return;
  const n = favCount();
  el.hidden = n === 0;
  el.textContent = n;
}
// a follow/unfollow star; data travels in attributes so the click handler can
// toggle without a lookup. Stops propagation so it doesn't trigger the row.
// Players without a RankedIn id (most FIP world-ranking rows) fall back to a
// name key so pros are still followable (no profile link, but push/board work).
function favKey(id, name) {
  if (id != null && id !== "") return String(id);
  return name ? "n:" + name : "";
}
function star(type, id, name, extra) {
  const key = favKey(id, name);
  if (!key) return "";
  const on = isFav(type, key);
  return `<button class="starbtn${on ? " on" : ""}" data-fav-type="${type}" data-fav-id="${esc(key)}" data-fav-name="${esc(name)}" data-fav-extra="${esc(extra || "")}" title="${on ? "Following — tap to remove" : "Follow"}" aria-label="follow">${on ? "★" : "☆"}</button>`;
}

// ---------- web push (Phase A) ----------
// The ⭐ follow set is the subscription: we register a service worker, ask for
// permission, subscribe with the VAPID public key, and POST the subscription +
// follows to /api/subscribe. Sending happens server-side (see scripts/push-test).
const VAPID_PUBLIC = "BPQSyr1X8qC5cQcjaPud1Rgu9Dv9fMN81DAo8dJtAd4NHFwR-bCMViuw0z68rGBjFbkuPGFPRblIbsuNx5HlU48";
let swReg = null;

const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function initPush() {
  if (!pushSupported()) { state.pushState = "unsupported"; return; }
  try {
    swReg = await navigator.serviceWorker.register("/sw.js");
    const sub = await swReg.pushManager.getSubscription();
    state.pushState = sub ? "subscribed" : Notification.permission === "denied" ? "denied" : "default";
  } catch { state.pushState = "unsupported"; }
  if (state.mode === "favorites") render();
}

async function enablePush() {
  if (!swReg) return;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { state.pushState = perm === "denied" ? "denied" : "default"; render(); return; }
  try {
    const sub = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC),
    });
    await fetch("/api/subscribe", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), follows: state.favs }),
    });
    state.pushState = "subscribed";
  } catch { state.pushState = "default"; }
  render();
}

async function disablePush() {
  if (!swReg) return;
  try {
    const sub = await swReg.pushManager.getSubscription();
    if (sub) {
      fetch("/api/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {}
  state.pushState = "default";
  render();
}

// keep the server's copy of the follow set current while subscribed
function syncPushFollows() {
  if (state.pushState !== "subscribed" || !swReg) return;
  swReg.pushManager.getSubscription().then((sub) => {
    if (sub) fetch("/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), follows: state.favs }) }).catch(() => {});
  });
}

const app = document.getElementById("app");
const state = {
  matches: [],
  meta: null,
  status: "all",
  fed: "all",
  query: "",
  expandedGroups: new Set(), // tournament ids
  groupCap: new Map(),       // tournament id -> max rows rendered
  openMatches: new Set(),    // match ids
  scoreSig: new Map(),       // id -> score signature (for flash)
  firstRender: true,
  // ---- archive (historic results) ----
  mode: "live",              // "live" | "archive"
  archive: null,             // loaded index.json
  archiveYear: "all",
  archiveCap: 40,
  openArchive: new Set(),    // expanded tournament keys
  archiveData: new Map(),    // key -> loaded tournament {matches}
  // ---- players (profiles / search / h2h) ----
  playerResults: null,       // search results
  player: null,              // loaded profile
  h2h: null,                 // loaded head-to-head
  comparing: false,          // in "pick an opponent" mode
  // ---- rankings ----
  rankings: null,            // loaded rankings.json
  rankFed: null,
  rankCat: null,
  rankCountryQuery: "",
  // ---- favorites ----
  favs: loadFavs(),
  pushState: "unknown", // unknown|unsupported|default|denied|subscribed
  // ---- tournament hub ----
  tournament: null,          // { kind:"live"|"arch", key, name, fed, matches }
};

// ---------- data ----------

const scoreSig = (m) => (m.score?.sets || []).map((s) => s.join("-")).join(",") + "|" + m.status;

async function load(isPoll) {
  const rf = document.getElementById("refresh");
  rf.classList.add("polling");
  try {
    const res = await fetch("data/matches.json?_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("no data — run `npm run fetch`");
    const data = await res.json();
    state.meta = data;
    // detect changed scores (for flash) before replacing
    const changed = new Set();
    for (const m of data.matches) {
      const sig = scoreSig(m);
      if (state.scoreSig.has(m.id) && state.scoreSig.get(m.id) !== sig) changed.add(m.id);
    }
    state.matches = data.matches;
    for (const m of data.matches) state.scoreSig.set(m.id, scoreSig(m));
    render(changed);
  } catch (err) {
    if (state.firstRender) app.innerHTML = `<div class="empty"><div class="big">🎾</div>${esc(err.message)}</div>`;
  } finally {
    state.firstRender = false;
    setTimeout(() => rf.classList.remove("polling"), 300);
  }
}

// ---------- filtering ----------

function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.matches.filter((m) => {
    if (state.status !== "all" && m.status !== state.status) return false;
    if (state.fed !== "all" && m.federation !== state.fed) return false;
    if (q) {
      const hay = (m.tournament.name + " " + m.teams.map((t) => t.name).join(" ") + " " + (m.className || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------- render ----------

function render(changed = new Set()) {
  renderControls();
  if (state.tournament) return renderTournament();
  if (state.mode === "favorites") return renderFavorites();
  if (state.mode === "rankings") return renderRankings();
  if (state.mode === "players") return renderPlayers();
  if (state.mode === "archive") return renderArchive();

  const list = filtered();
  const live = list.filter((m) => m.status === "live");
  const rest = list.filter((m) => m.status !== "live");

  let html = "";
  if (live.length) {
    html += `<div class="section-label live"><span class="lampe"></span>Live now · ${live.length}</div>`;
    html += `<div class="group open"><div class="group__body">${live.map((m) => matchRow(m, changed, true)).join("")}</div></div>`;
  }

  if (rest.length) {
    if (live.length) html += `<div class="section-label">All matches</div>`;
    html += renderGroups(rest, changed);
  }

  if (!list.length) {
    html = `<div class="empty"><div class="big">🎾</div>No ${state.status === "all" ? "" : state.status + " "}matches${state.query ? " for “" + esc(state.query) + "”" : ""}.</div>`;
  }
  app.innerHTML = html;
}

// Federation → section label (FIP grouped as one "international" section).
const REGION_LABEL = {
  FIP: "FIP International", DK: "Denmark", SE: "Sweden", NO: "Norway",
  DE: "Germany", CZ: "Czechia", FI: "Finland", FR: "France",
  HR: "Croatia", EE: "Estonia", GE: "Georgia",
  HU: "Hungary", UA: "Ukraine", SI: "Slovenia", XK: "Kosovo", BA: "Bosnia", ME: "Montenegro",
};

function renderGroups(matches, changed) {
  // group by tournament, preserve aggregate order
  const groups = new Map();
  for (const m of matches) {
    const key = m.source + ":" + m.tournament.id;
    if (!groups.has(key)) groups.set(key, { key, t: m.tournament, fed: m.federation, matches: [] });
    groups.get(key).matches.push(m);
  }
  const arr = [...groups.values()];

  // auto-expand only live groups + the first (keeps the DOM light), until the
  // user starts toggling groups themselves.
  arr.forEach((g, i) => {
    if (!state._touched) {
      const hasLive = g.matches.some((m) => m.status === "live");
      if (hasLive || i === 0) state.expandedGroups.add(g.key);
    }
  });

  // bucket tournaments into federation sections; FIP International first, rest A–Z
  const sections = new Map();
  for (const g of arr) {
    if (!sections.has(g.fed)) sections.set(g.fed, []);
    sections.get(g.fed).push(g);
  }
  const ordered = [...sections.entries()].sort((a, b) => {
    const ka = a[0] === "FIP" ? "" : REGION_LABEL[a[0]] || a[0];
    const kb = b[0] === "FIP" ? "" : REGION_LABEL[b[0]] || b[0];
    return ka.localeCompare(kb);
  });

  return ordered
    .map(([fed, gs]) => {
      const n = gs.reduce((s, g) => s + g.matches.length, 0);
      const header =
        `<div class="section-label region"><span class="rflag">${FLAGS[fed] || ""}</span>${esc(REGION_LABEL[fed] || fed)}` +
        `<span class="count">${gs.length} ${gs.length === 1 ? "event" : "events"} · ${n} matches</span></div>`;
      return header + gs.map((g) => groupHtml(g, changed)).join("");
    })
    .join("");
}

function groupHtml(g, changed) {
  const open = state.expandedGroups.has(g.key);
  const nLive = g.matches.filter((m) => m.status === "live").length;
  const cap = state.groupCap.get(g.key) || 20;
  const shown = g.matches.slice(0, cap);
  const more = g.matches.length - shown.length;
  return `
    <div class="group ${open ? "open" : ""}" data-group="${esc(g.key)}">
      <div class="group__head" data-toggle="${esc(g.key)}">
        <span class="group__title tlink" data-tourney="live" data-tkey="${esc(g.key)}" data-tname="${esc(g.t.name)}" data-tfed="${esc(g.fed)}">${esc(g.t.name)}</span>
        <span class="group__meta">
          ${nLive ? `<span class="badge live">${nLive} live</span>` : ""}
          <span class="count">${g.matches.length}</span>
          ${star("tournaments", g.key, g.t.name, g.fed)}
          <span class="chev">▶</span>
        </span>
      </div>
      <div class="group__body">${
        open
          ? shown.map((m) => matchRow(m, changed, false)).join("") +
            (more > 0 ? `<button class="morebtn" data-more="${esc(g.key)}">Show ${more} more ↓</button>` : "")
          : ""
      }</div>
    </div>`;
}

// Compact time label for an upcoming match. Prefers an explicit RankedIn time,
// then the FIP order-of-play phrase ("Starting at 10:00 AM" -> "10:00", "Not
// before 3:00 PM" -> "~15:00"), then our per-court estimate ("≈13:10"), else
// "next" (followed by). All venue-local.
function schedLabel(m) {
  if (m.startTime) return m.startTime.slice(11, 16);
  const sched = m.schedule || "";
  const t = sched.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (t) {
    let h = +t[1]; const ap = (t[3] || "").toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    const hhmm = String(h).padStart(2, "0") + ":" + t[2];
    return /not before/i.test(sched) ? "~" + hhmm : hhmm;
  }
  if (m.estStart) return "≈" + m.estStart;
  return /follow/i.test(sched) ? "next" : null;
}

function matchRow(m, changed, showTournament) {
  const open = state.openMatches.has(m.id);
  const isChanged = changed.has(m.id);
  const time = m.startTime ? m.startTime.slice(11, 16) : "";
  const followed = /follow/i.test(m.schedule || "") && m.estStart; // estimate is "next up"
  const stateCol =
    m.status === "live"
      ? `<span class="lampe"></span><span class="badge live">Live</span>`
      : m.status === "final"
      ? `<span class="badge final">Final</span>`
      : `${followed ? `<span class="foll">Followed by</span>` : ""}<span class="badge upcoming">${schedLabel(m) || "Soon"}</span>`;

  return `
    <div class="match ${open ? "open" : ""}" data-match="${esc(m.id)}">
      <div class="match__main" data-open="${esc(m.id)}">
        <div class="match__state">${stateCol}${m.status !== "upcoming" && time ? `<span class="t">${time}</span>` : ""}</div>
        <div class="teams">
          ${showTournament ? `<div class="team"><span class="flag" style="font-size:10px">${FLAGS[m.federation] || ""} ${m.federation}</span><span class="nm" style="color:var(--muted);font-size:12px">${esc(m.tournament.name)}</span></div>` : ""}
          ${teamLine(m, 0, isChanged)}
          ${teamLine(m, 1, isChanged)}
        </div>
      </div>
      ${detail(m)}
    </div>`;
}

function teamLine(m, side, isChanged) {
  const t = m.teams[side];
  const win = m.score.winner === side;
  const sets = m.score.sets || [];
  const cells = sets.length
    ? `<div class="sets">${sets.map((s) => `<${win ? "b" : "span"} class="${isChanged ? "flash" : ""}">${esc(s[side])}</${win ? "b" : "span"}>`).join("")}</div>`
    : side === 0
    ? `<span class="vs">vs</span>`
    : "";
  return `<div class="team ${win ? "win" : ""}"><span class="nm">${esc(t.name)}</span>${cells}</div>`;
}

function detail(m) {
  const sets = m.score.sets || [];
  const setGrid = sets.length
    ? `<div class="grid">${sets.map((s, i) => `<div class="setcol"><div class="lbl">Set ${i + 1}</div><div class="val">${esc(s[0])}–${esc(s[1])}</div></div>`).join("")}</div>`
    : `<div style="margin:6px 0 10px;color:var(--faint)">No score yet.</div>`;
  const kv = [
    m.className && `<span>Class <b>${esc(m.className)}</b></span>`,
    m.round && `<span>Round <b>${esc(m.round)}</b></span>`,
    m.court && `<span>Court <b>${esc(m.court)}</b></span>`,
    m.schedule && `<span>Order of play <b>${esc(m.schedule)}</b></span>`,
    m.estStart && !/\d/.test(m.schedule || "") && `<span>Est. start <b>≈${esc(m.estStart)}</b></span>`,
    m.startTime && `<span>Start <b>${esc(m.startTime.replace("T", " ").slice(0, 16))}</b></span>`,
  ].filter(Boolean).join("");
  return `
    <div class="detail">
      ${setGrid}
      <div class="kv">${kv}</div>
      <a class="src" href="${esc(m.tournament.url)}" target="_blank" rel="noopener">↗ View on ${esc(SOURCE_LABEL[m.source] || m.source)}</a>
    </div>`;
}

// ---------- controls ----------

function renderControls() {
  // live pill on the Live tab
  const nLive = state.matches.filter((m) => m.status === "live").length;
  const pill = document.getElementById("livepill");
  pill.hidden = nLive === 0;
  pill.textContent = nLive;

  // federation chips reflect the active dataset (live matches OR archive)
  const feds =
    state.mode === "archive" && state.archive
      ? [...new Set(state.archive.tournaments.map((t) => t.federation))].sort()
      : [...new Set(state.matches.map((m) => m.federation))].sort();
  const chips = document.getElementById("chips");
  const key = state.mode + ":" + feds.join(",");
  if (feds.length && chips.dataset.key !== key) {
    chips.dataset.key = key;
    chips.innerHTML =
      `<span class="chip ${state.fed === "all" ? "active" : ""}" data-fed="all">All</span>` +
      feds.map((f) => `<span class="chip ${state.fed === f ? "active" : ""}" data-fed="${f}">${FLAGS[f] || ""} ${f}</span>`).join("");
  }

  // refresh label
  if (state.mode === "archive") {
    document.getElementById("refresh-txt").textContent = state.archive ? `${state.archive.count} tournaments` : "loading…";
  } else if (state.meta) {
    document.getElementById("refresh-txt").textContent = `${state.meta.date} · updated ${timeago(new Date(state.meta.generatedAt))}`;
  }
}

// ---------- archive (historic results) ----------

async function loadArchive() {
  app.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
  try {
    state.archive = await (await fetch("data/archive/index.json")).json();
  } catch {
    app.innerHTML = `<div class="empty"><div class="big">📅</div>Results archive not available.</div>`;
    return;
  }
  const years = [...new Set(state.archive.tournaments.map((t) => (t.start || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  document.getElementById("year").innerHTML =
    `<option value="all">All years</option>` + years.map((y) => `<option value="${y}">${y}</option>`).join("");
  render();
}

function renderArchive() {
  const q = state.query.trim().toLowerCase();
  const list = state.archive.tournaments.filter((t) => {
    if (state.fed !== "all" && t.federation !== state.fed) return false;
    if (state.archiveYear !== "all" && (t.start || "").slice(0, 4) !== state.archiveYear) return false;
    if (q && !t.name.toLowerCase().includes(q)) return false;
    return true;
  });
  const shown = list.slice(0, state.archiveCap);
  let html =
    `<div class="section-label region">📅 ${list.length} tournament${list.length === 1 ? "" : "s"}` +
    `<span class="count">${state.archive.count} in archive · 2020–2026</span></div>`;
  html += shown.map(archiveRow).join("");
  if (list.length > shown.length)
    html += `<button class="morebtn" data-archmore="1">Show ${list.length - shown.length} more ↓</button>`;
  if (!list.length) html = `<div class="empty"><div class="big">📅</div>No tournaments match.</div>`;
  app.innerHTML = html;
}

function archiveRow(t) {
  const open = state.openArchive.has(t.key);
  const loaded = state.archiveData.get(t.key);
  return `
    <div class="group ${open ? "open" : ""}" data-arch="${esc(t.key)}">
      <div class="group__head" data-archtoggle="${esc(t.key)}">
        <span class="flag">${FLAGS[t.federation] || ""} ${t.federation}</span>
        <span class="group__title tlink" data-tourney="arch" data-tkey="${esc(t.key)}" data-tname="${esc(t.name)}" data-tfed="${esc(t.federation)}">${esc(t.name)}</span>
        <span class="group__meta"><span class="count">${esc((t.start || "").slice(0, 10))} · ${t.n}</span><span class="chev">▶</span></span>
      </div>
      <div class="group__body">${open ? (loaded ? archiveMatches(loaded) : `<div class="detail" style="display:block">Loading…</div>`) : ""}</div>
    </div>`;
}

function archiveMatches(t) {
  const byClass = new Map();
  for (const m of t.matches) {
    const k = m.className || "—";
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k).push(m);
  }
  return [...byClass.entries()]
    .map(([cls, ms]) => (cls && cls !== "—" ? `<div class="arch-class">${esc(cls)}</div>` : "") + ms.map(archiveMatchRow).join(""))
    .join("");
}

function archiveMatchRow(m) {
  return `<div class="match"><div class="match__main archm">
    <div class="teams">${teamLine(m, 0, false)}${teamLine(m, 1, false)}</div>
    <div class="side">${m.round ? `<span class="sub">${esc(m.round)}</span>` : ""}</div>
  </div></div>`;
}

// ---------- players (profiles / search / head-to-head) ----------

async function searchPlayers(q) {
  if ((q || "").trim().length < 2) { state.playerResults = null; render(); return; }
  try {
    const d = await (await fetch("/api/search?q=" + encodeURIComponent(q.trim()))).json();
    state.playerResults = d.players || [];
  } catch { state.playerResults = []; }
  render();
}

async function openPlayer(id) {
  state.h2h = null; state.comparing = false; state.player = "loading";
  render();
  try { state.player = await (await fetch("/api/player/" + encodeURIComponent(id))).json(); } catch { state.player = null; }
  render();
}

async function openH2H(aId, bId) {
  state.comparing = false; state.h2h = "loading"; render();
  try { state.h2h = await (await fetch(`/api/h2h?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`)).json(); } catch { state.h2h = null; }
  render();
}

function renderPlayers() {
  if (state.h2h) return renderH2H();
  if (state.player) return renderProfile();
  let html;
  if (state.playerResults == null)
    html = `<div class="empty"><div class="big">👤</div>Search a player to see their profile, results &amp; head-to-head.</div>`;
  else if (!state.playerResults.length)
    html = `<div class="empty"><div class="big">👤</div>No players found. (Profiles cover players with a RankedIn id — Nordic scene + linked pros.)</div>`;
  else html = state.playerResults.map(playerResultRow).join("");
  app.innerHTML = html;
}

function playerResultRow(p) {
  return `<div class="presult" data-player="${esc(p.id)}">
    <span class="flag">${esc((p.country || "").toUpperCase())}</span>
    <span class="nm">${esc(p.name)}</span>
    <span class="meta">${p.matches} matches</span>
    ${star("players", p.id, p.name, p.country || "")}
  </div>`;
}

function renderProfile() {
  if (state.player === "loading") { app.innerHTML = `<div class="skel"></div><div class="skel"></div>`; return; }
  const { player, summary, matches } = state.player;
  const pct = summary.total ? Math.round((summary.wins / summary.total) * 100) : 0;
  let html = `<button class="pback" data-pback="1">← Search</button>
    <div class="phead">
      <span class="flag">${esc((player.country || "").toUpperCase())}</span>
      <h2>${esc(player.name)}</h2>
      ${star("players", player.id, player.name, player.country || "")}
      <div class="pstats">
        <div class="pstat"><b>${summary.total}</b><span>matches</span></div>
        <div class="pstat"><b>${summary.wins}-${summary.losses}</b><span>W-L</span></div>
        <div class="pstat"><b>${pct}%</b><span>win rate</span></div>
      </div>
    </div>
    <button class="pcompare ${state.comparing ? "on" : ""}" data-compare="1">⚔️ ${state.comparing ? "Now search an opponent above…" : "Head-to-head vs…"}</button>`;
  if (state.comparing && state.playerResults && state.playerResults.length)
    html += `<div class="section-label">Tap an opponent</div>` +
      state.playerResults.filter((p) => p.id !== player.id).map(playerResultRow).join("");
  const years = summary.byYear.map((y) => `${y.yr}: ${y.won}/${y.played}`).join("   ·   ");
  if (years) html += `<div class="section-label">By year</div><div class="detail" style="display:block">${esc(years)}</div>`;
  html += `<div class="section-label">Recent matches (${matches.length})</div>` + matches.map((m) => apiMatchRow(m)).join("");
  app.innerHTML = html;
}

function renderH2H() {
  if (state.h2h === "loading") { app.innerHTML = `<div class="skel"></div><div class="skel"></div>`; return; }
  const { a, b, asOpponents, asPartners } = state.h2h;
  let html = `<button class="pback" data-pback="1">← Back</button>
    <div class="phead"><h2>${esc(a.name)} <span style="color:var(--faint)">vs</span> ${esc(b.name)}</h2></div>
    <div class="section-label">As opponents · ${asOpponents.list.length} meeting${asOpponents.list.length === 1 ? "" : "s"}</div>
    <div class="h2h-tally">
      <div><div class="n">${asOpponents.aWins}</div><div class="who">${esc(a.name)}</div></div>
      <span class="vs">–</span>
      <div><div class="n">${asOpponents.bWins}</div><div class="who">${esc(b.name)}</div></div>
    </div>`;
  html += asOpponents.list.slice(0, 30).map((m) => apiMatchRow(m)).join("");
  if (asPartners.list.length) {
    html += `<div class="section-label">As partners · ${asPartners.list.length} match${asPartners.list.length === 1 ? "" : "es"} (${asPartners.wins}W)</div>`;
    html += asPartners.list.slice(0, 20).map((m) => apiMatchRow(m)).join("");
  }
  app.innerHTML = html;
}

function apiMatchRow(m) {
  const t = m.teams;
  const line = (s) => `<div class="team ${t[s].won ? "win" : ""}"><span class="nm">${esc(t[s].name)}</span></div>`;
  const sub = [m.date, m.tournament, m.round].filter(Boolean).join(" · ");
  return `<div class="match"><div class="match__main archm">
    <div class="teams">${line(0)}${line(1)}</div>
    <div class="side"><span class="score-str">${esc(m.score || "")}</span><span class="sub">${esc(sub)}</span></div>
  </div></div>`;
}

// ---------- favorites (the "My PadelTicker" board) ----------

const surnameOf = (n) => (n || "").trim().split(/\s+/).pop().toLowerCase();

// best-effort: does a live match involve a followed player? names differ in
// format across sources ("A. Coello" vs "Arturo Coello"), so match on surname.
function matchInvolvesFav(m, players, followedT) {
  if (followedT.has(m.source + ":" + m.tournament.id)) return true;
  return players.some(([, d]) => {
    const s = surnameOf(d.name);
    return s.length >= 3 && m.teams.some((t) => (t.name || "").toLowerCase().includes(s));
  });
}

function pushBanner() {
  switch (state.pushState) {
    case "subscribed":
      return `<div class="pushbar on"><span>🔔 Push alerts are on for your follows.</span><button class="pushbtn" data-push="off">Turn off</button></div>`;
    case "denied":
      return `<div class="pushbar off">🔕 Notifications are blocked — enable them in your browser's site settings, then reload.</div>`;
    case "unsupported":
      return `<div class="pushbar off">🔕 Push isn't supported in this browser. <span class="hint">On iPhone: add PadelTicker to your Home Screen, then reopen and try again.</span></div>`;
    case "default":
      return `<div class="pushbar"><span>🔔 Get a push when a followed player or tournament goes live.</span><button class="pushbtn" data-push="on">Enable alerts</button></div>`;
    default:
      return ""; // "unknown" — service worker still initialising
  }
}

function renderFavorites() {
  const P = Object.entries(state.favs.players);
  const T = Object.entries(state.favs.tournaments);
  if (!P.length && !T.length) {
    app.innerHTML = pushBanner() +
      `<div class="empty"><div class="big">⭐</div>Follow players and tournaments with the ☆ star — they show up here, with their matches surfaced when they're on.</div>`;
    return;
  }
  const followedT = new Set(T.map(([k]) => k));
  const onNow = state.matches
    .filter((m) => m.status !== "final" && matchInvolvesFav(m, P, followedT))
    .sort((a, b) => (a.status === "live" ? -1 : 1) - (b.status === "live" ? -1 : 1));

  let html = pushBanner();
  if (onNow.length) {
    const nLive = onNow.filter((m) => m.status === "live").length;
    html += `<div class="section-label ${nLive ? "live" : ""}">${nLive ? '<span class="lampe"></span>' : "⭐ "}Your follows${nLive ? " · on now" : " · coming up"} · ${onNow.length}</div>`;
    html += `<div class="group open"><div class="group__body">${onNow.slice(0, 40).map((m) => matchRow(m, new Set(), true)).join("")}</div></div>`;
  }
  if (P.length) {
    html += `<div class="section-label">⭐ Players · ${P.length}</div>`;
    html += P.map(([id, d]) => favPlayerRow(id, d)).join("");
  }
  if (T.length) {
    html += `<div class="section-label">⭐ Tournaments · ${T.length}</div>`;
    html += T.map(([k, d]) => favTournRow(k, d)).join("");
  }
  app.innerHTML = html;
}

function favPlayerRow(id, d) {
  const linked = !id.startsWith("n:"); // name-keyed pros have no profile
  return `<div class="presult${linked ? " has-profile" : ""}"${linked ? ` data-player="${esc(id)}"` : ""}>
    <span class="flag">${esc((d.extra || "").toUpperCase())}</span>
    <span class="nm">${esc(d.name)}</span>
    ${linked ? "" : `<span class="meta">pro</span>`}
    <button class="starbtn on" data-fav-type="players" data-fav-id="${esc(id)}" data-fav-name="${esc(d.name)}" data-fav-extra="${esc(d.extra || "")}" title="Following — tap to remove">★</button>
  </div>`;
}

function favTournRow(k, d) {
  const n = state.matches.filter((m) => m.source + ":" + m.tournament.id === k).length;
  return `<div class="presult">
    <span class="flag">${FLAGS[d.extra] || ""} ${esc(d.extra || "")}</span>
    <span class="nm">${esc(d.name)}</span>
    <span class="meta">${n ? n + " live/upcoming" : "—"}</span>
    ${star("tournaments", k, d.name, d.extra)}
  </div>`;
}

// ---------- tournament hub (the "draw" page for one event) ----------

// order rounds for a draw: business end (Final) first, group/qualifying last.
function roundRank(r) {
  const s = (r || "").toLowerCase();
  // NB: check semi/quarter BEFORE final — "quarterfinals"/"semifinals" both
  // contain the substring "final". Match a real final only as a whole word.
  if (/plats|platz|place|3rd|5th/.test(s)) return 85;             // placement matches
  if (/semi/.test(s)) return 90;
  if (/quarter|kvart/.test(s)) return 80;
  if (/\bfinals?\b|\bfinale\b/.test(s)) return 100;
  if (/round of 16|1\/8|\br16\b|åttendel|ottendel/.test(s)) return 70;
  if (/round of 32|1\/16|\br32\b/.test(s)) return 60;
  if (/round of 64|1\/32|\br64\b/.test(s)) return 50;
  if (/round 1|runde 1|round one/.test(s)) return 40;
  if (/group|gruppe|grupp|round ?robin|monrad|pool/.test(s)) return 20;
  if (/q\d|quali|kval/.test(s)) return 15;
  return 30; // unknown / named regional groups
}

// when className is empty, a "Men/Women …" round prefix acts as the category
function splitCategory(m) {
  let cls = m.className || "";
  let round = m.round || "";
  if (!cls) {
    const g = round.match(/^(Men|Women|Herren|Damen|Herrer?|Damer?|Mixed)\s+/i);
    if (g) { cls = g[1]; round = round.slice(g[0].length).trim(); }
  }
  return { cls, round };
}

function openTournament(kind, key, name, fed) {
  state.tournament = { kind, key, name, fed, matches: kind === "live" ? null : "loading" };
  if (kind === "arch") {
    if (state.archiveData.has(key)) {
      state.tournament.matches = state.archiveData.get(key).matches;
    } else {
      render(); // shows skeleton
      fetch(`data/archive/t/${key}.json`)
        .then((r) => r.json())
        .then((d) => { state.archiveData.set(key, d); if (state.tournament && state.tournament.key === key) state.tournament.matches = d.matches; render(); })
        .catch(() => { if (state.tournament) state.tournament.matches = []; render(); });
      return;
    }
  }
  try { window.scrollTo(0, 0); } catch {}
  render();
}

function renderTournament() {
  const tv = state.tournament;
  const back = `<button class="pback" data-tback="1">← Back</button>`;
  let matches = tv.kind === "live" ? state.matches.filter((m) => m.source + ":" + m.tournament.id === tv.key) : tv.matches;
  if (matches === "loading") { app.innerHTML = back + `<div class="skel"></div><div class="skel"></div>`; return; }
  matches = matches || [];

  const players = new Set();
  for (const m of matches) for (const t of m.teams) for (const p of (t.name || "").split("/")) { const n = p.trim(); if (n) players.add(n); }
  const dates = matches.map((m) => m.startTime || m.date).filter(Boolean).map((s) => s.slice(0, 10)).sort();
  const dateStr = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`) : "";
  const nLive = matches.filter((m) => m.status === "live").length;
  const src = matches.find((m) => m.tournament?.url);

  let html = back + `<div class="thead">
    <div class="trow1"><span class="flag">${FLAGS[tv.fed] || ""} ${esc(tv.fed || "")}</span>${star("tournaments", tv.key, tv.name, tv.fed)}</div>
    <h2>${esc(tv.name)}</h2>
    <div class="tmeta">${matches.length} matches · ${players.size} players${dateStr ? " · " + esc(dateStr) : ""}${nLive ? ` · <span class="badge live">${nLive} live</span>` : ""}</div>
    ${src ? `<a class="src" href="${esc(src.tournament.url)}" target="_blank" rel="noopener">↗ View on ${esc(SOURCE_LABEL[src.source] || src.source)}</a>` : ""}
  </div>`;

  if (!matches.length) { app.innerHTML = html + `<div class="empty">No matches for this event yet.</div>`; return; }

  // group by category (class) → round, rounds ordered final-first
  const cats = new Map();
  for (const m of matches) {
    const { cls, round } = splitCategory(m);
    if (!cats.has(cls)) cats.set(cls, new Map());
    const rmap = cats.get(cls);
    if (!rmap.has(round)) rmap.set(round, []);
    rmap.get(round).push(m);
  }
  for (const [cls, rmap] of cats) {
    if (cls) html += `<div class="section-label region">${esc(cls)}</div>`;
    const rounds = [...rmap.entries()].sort((a, b) => roundRank(b[0]) - roundRank(a[0]));
    for (const [round, ms] of rounds) {
      if (round) html += `<div class="round-label">${esc(round)}</div>`;
      html += `<div class="group open"><div class="group__body">${ms.map((m) => (tv.kind === "live" ? matchRow(m, new Set(), false) : archiveMatchRow(m))).join("")}</div></div>`;
    }
  }
  if (players.size) html += `<div class="section-label">Players · ${players.size}</div><div class="tplayers">${[...players].sort().map((p) => `<span class="pchip">${esc(p)}</span>`).join("")}</div>`;
  app.innerHTML = html;
}

// ---------- rankings (national, RankedIn) ----------

async function loadRankings() {
  app.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
  const grab = (u) => fetch(u + "?_=" + Date.now()).then((r) => (r.ok ? r.json() : { lists: [] })).catch(() => ({ lists: [] }));
  const [fip, nat] = await Promise.all([grab("data/rankings-fip.json"), grab("data/rankings.json")]);
  const lists = [...(fip.lists || []), ...(nat.lists || [])]; // FIP world first, then national
  if (!lists.length) {
    app.innerHTML = `<div class="empty"><div class="big">🏆</div>Rankings not available.</div>`;
    return;
  }
  state.rankings = { lists };
  render();
}

function renderRankings() {
  if (!state.rankings) return;
  const lists = state.rankings.lists;
  const feds = [...new Set(lists.map((l) => l.fed))];
  const cats = [...new Set(lists.map((l) => l.category))];
  if (!state.rankFed || !feds.includes(state.rankFed)) state.rankFed = feds[0];
  if (!state.rankCat || !cats.includes(state.rankCat)) state.rankCat = cats[0];
  const list = lists.find((l) => l.fed === state.rankFed && l.category === state.rankCat);
  const q = state.query.trim().toLowerCase();
  const rows = (list?.rows || []).filter((r) => !q || (r.name || "").toLowerCase().includes(q) || (r.club || "").toLowerCase().includes(q));

  let html = `<div class="rank-country-wrap">
    <input id="rankcountry" class="rank-country" type="search" placeholder="🔎 Find country…" autocomplete="off" value="${esc(state.rankCountryQuery || "")}" />
    <span class="rank-nomatch" hidden>No country matches</span>
  </div>
  <div class="rank-sel" id="ranksel">
    ${feds.map((f) => `<button class="rchip ${state.rankFed === f ? "on" : ""}" data-rfed="${f}" title="${esc(REGION_LABEL[f] || f)}">${FLAGS[f] || ""} ${f}</button>`).join("")}
    <span class="rsep"></span>
    ${cats.map((c) => `<button class="rchip ${state.rankCat === c ? "on" : ""}" data-rcat="${c}">${c === "men" ? "Men" : c === "women" ? "Women" : esc(c)}</button>`).join("")}
  </div>`;
  const movement = !!list?.movement;
  html += `<div class="section-label region"><span class="rflag">${FLAGS[state.rankFed] || ""}</span>${state.rankFed} ${list?.label || ""} ranking` +
    `<span class="count">${(list?.total ?? rows.length).toLocaleString()} ranked · top ${list?.rows?.length || 0}${movement ? " · ▲▼ vs last week" : ""}</span></div>`;
  html += `<div class="ranktable${movement ? " hasmove" : ""}">` + rows.slice(0, 250).map((r) => rankRow(r, movement)).join("") + `</div>`;
  if (!rows.length) html += `<div class="empty">No players match.</div>`;
  app.innerHTML = html;
  applyCountryFilter();
}

// Filter the ranking's federation chips by country name/code. Runs as a direct
// DOM update (not a full render) so the input keeps focus while typing.
function applyCountryFilter() {
  const q = (state.rankCountryQuery || "").trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll("#ranksel .rchip[data-rfed]").forEach((el) => {
    const f = el.dataset.rfed;
    const hay = (f + " " + (REGION_LABEL[f] || "") + (f === "FIP" ? " world international" : "")).toLowerCase();
    const hide = !!q && !hay.includes(q);
    el.classList.toggle("chip-hidden", hide);
    if (!hide) visible++;
  });
  const nm = document.querySelector(".rank-nomatch");
  if (nm) nm.hidden = visible > 0;
}

function moveCell(r, movement) {
  if (!movement) return "";                                   // list has no movement data
  if (r.delta === undefined) return `<span class="mv zero">·</span>`; // untracked row
  if (r.delta === null) return `<span class="mv new">NEW</span>`;
  if (r.delta > 0) return `<span class="mv up">▲${r.delta}</span>`;
  if (r.delta < 0) return `<span class="mv down">▼${-r.delta}</span>`;
  return `<span class="mv zero">–</span>`;                     // unchanged
}

function rankRow(r, movement) {
  const prof = r.id ? " has-profile" : "";
  const medal = r.rank <= 3 ? ` medal m${r.rank}` : "";
  return `<div class="rankrow${prof}${medal}"${r.id ? ` data-player="${esc(r.id)}"` : ""}>
    <span class="rnum">${r.rank}</span>
    <span class="rmove">${moveCell(r, movement)}</span>
    <span class="nm">${esc(r.name)}</span>
    <span class="rclub">${esc(r.club || "")}</span>
    <span class="rpts">${r.points != null ? Math.round(r.points).toLocaleString() : ""}</span>
    <span class="rstar">${star("players", r.id, r.name, r.country || "")}</span>
  </div>`;
}

function timeago(d) {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
}

// ---------- events ----------

document.getElementById("tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  state.status = b.dataset.status;
  document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.toggle("active", t === b));
  render();
});

document.getElementById("chips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  state.fed = c.dataset.fed;
  document.querySelectorAll("#chips .chip").forEach((x) => x.classList.toggle("active", x === c));
  render();
});

// mode switch: Live / Results / Players / Rankings
function activateMode(mode) {
  state.mode = mode;
  state.fed = "all";
  state.query = "";
  state.player = null; state.h2h = null; state.playerResults = null; state.comparing = false;
  state.tournament = null;
  state.rankCountryQuery = "";
  document.querySelectorAll("#modes button").forEach((x) => x.classList.toggle("active", x.dataset.mode === mode));
  document.getElementById("tabs").style.display = mode === "live" ? "" : "none";
  document.getElementById("year").hidden = mode !== "archive";
  document.getElementById("chips").style.display = mode === "live" || mode === "archive" ? "" : "none";
  const qEl = document.getElementById("q");
  qEl.value = "";
  qEl.closest(".search").style.display = mode === "favorites" ? "none" : "";
  qEl.placeholder =
    mode === "players" ? "Search a player by name…" :
    mode === "rankings" ? "Filter this ranking…" :
    mode === "archive" ? "Search tournament…" : "Search player or tournament…";
  if (mode === "archive" && !state.archive) loadArchive();
  else if (mode === "rankings" && !state.rankings) loadRankings();
  else render();
}

document.getElementById("modes").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && b.dataset.mode !== state.mode) activateMode(b.dataset.mode);
});

document.getElementById("year").addEventListener("change", (e) => {
  state.archiveYear = e.target.value;
  state.archiveCap = 40;
  render();
});

// rankings country filter — narrows the federation chips without re-rendering
// #app (so the input keeps focus). Enter jumps to a lone match.
app.addEventListener("input", (e) => {
  if (e.target.id !== "rankcountry") return;
  state.rankCountryQuery = e.target.value;
  applyCountryFilter();
});
app.addEventListener("keydown", (e) => {
  if (e.target.id !== "rankcountry" || e.key !== "Enter") return;
  const vis = [...document.querySelectorAll("#ranksel .rchip[data-rfed]:not(.chip-hidden)")];
  if (vis.length === 1 && vis[0].dataset.rfed !== state.rankFed) { state.rankFed = vis[0].dataset.rfed; render(); }
});

let qTimer;
document.getElementById("q").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  const v = e.target.value;
  qTimer = setTimeout(() => {
    if (state.mode === "players") return searchPlayers(v);
    state.query = v;
    if (state.mode === "archive") state.archiveCap = 40;
    render();
  }, 200);
});

app.addEventListener("click", (e) => {
  // follow/unfollow star — handle first so it doesn't trigger the row/group
  const fav = e.target.closest("[data-fav-type]");
  if (fav) {
    e.stopPropagation();
    toggleFav(fav.dataset.favType, fav.dataset.favId, fav.dataset.favName, fav.dataset.favExtra);
    render();
    return;
  }

  // tournament hub: open a tournament's draw page (title click pre-empts toggle)
  const tourney = e.target.closest("[data-tourney]");
  if (tourney) {
    e.stopPropagation();
    openTournament(tourney.dataset.tourney, tourney.dataset.tkey, tourney.dataset.tname, tourney.dataset.tfed);
    return;
  }
  if (e.target.closest("[data-tback]")) { state.tournament = null; render(); return; }

  // push alerts enable/disable
  const pb = e.target.closest("[data-push]");
  if (pb) { pb.dataset.push === "on" ? enablePush() : disablePush(); return; }

  // rankings: federation / category selector
  const rf = e.target.closest("[data-rfed]");
  if (rf) { state.rankFed = rf.dataset.rfed; render(); return; }
  const rc = e.target.closest("[data-rcat]");
  if (rc) { state.rankCat = rc.dataset.rcat; render(); return; }

  // players: result click / compare / back (also from a ranked player row)
  const pr = e.target.closest("[data-player]");
  if (pr) {
    const id = pr.dataset.player;
    if (state.mode === "rankings") { activateMode("players"); openPlayer(id); return; }
    if (state.comparing && state.player && state.player.player) openH2H(state.player.player.id, id);
    else openPlayer(id);
    return;
  }
  if (e.target.closest("[data-pback]")) {
    if (state.h2h) state.h2h = null;
    else state.player = null;
    render();
    return;
  }
  if (e.target.closest("[data-compare]")) {
    state.comparing = !state.comparing;
    if (state.comparing) document.getElementById("q").focus();
    render();
    return;
  }

  // archive: expand a tournament (lazy-load its matches)
  const arch = e.target.closest("[data-archtoggle]");
  if (arch) {
    const key = arch.dataset.archtoggle;
    if (state.openArchive.has(key)) {
      state.openArchive.delete(key);
      render();
    } else {
      state.openArchive.add(key);
      if (!state.archiveData.has(key)) {
        render(); // shows "Loading…"
        fetch(`data/archive/t/${key}.json`)
          .then((r) => r.json())
          .then((d) => { state.archiveData.set(key, d); render(); })
          .catch(() => {});
      } else render();
    }
    return;
  }
  if (e.target.closest("[data-archmore]")) {
    state.archiveCap += 60;
    render();
    return;
  }

  const tog = e.target.closest("[data-toggle]");
  if (tog) {
    state._touched = true;
    const key = tog.dataset.toggle;
    if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
    else state.expandedGroups.add(key);
    render();
    return;
  }
  const more = e.target.closest("[data-more]");
  if (more) {
    const k = more.dataset.more;
    state.groupCap.set(k, (state.groupCap.get(k) || 20) + 40);
    render();
    return;
  }
  const om = e.target.closest("[data-open]");
  if (om) {
    const id = om.dataset.open;
    if (state.openMatches.has(id)) state.openMatches.delete(id);
    else state.openMatches.add(id);
    render();
  }
});

// theme toggle (persists)
const themeBtn = document.getElementById("theme");
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; };
applyTheme(localStorage.getItem("pls-theme"));
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  const isDark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = isDark ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem("pls-theme", next);
});

// ---------- boot ----------
// Self-scheduling poll loop whose interval adapts to what's on: fast while a
// match is live, slow when nothing is happening.
function nextPollDelay() {
  if (state.matches.some((m) => m.status === "live")) return POLL_LIVE;
  if (state.matches.some((m) => m.status === "upcoming")) return POLL_UPCOMING;
  return POLL_IDLE;
}
function pollLoop() {
  setTimeout(async () => {
    await load(true);
    pollLoop();
  }, nextPollDelay());
}

updateFavBadge();
initPush();
app.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
load(false).then(pollLoop);
// keep the "updated Xs ago" label ticking
setInterval(renderControls, 15_000);
