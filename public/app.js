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
  playerId: null,            // id of the open/loading profile (for the URL)
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
  if (state.mode === "events") return renderEvents();
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

// minutes-of-day start key for ordering upcoming matches chronologically.
// Uses the estimate (FIP), then an explicit RankedIn time, then the OOP phrase.
function startMin(m) {
  let hhmm = m.estStart || (m.startTime ? m.startTime.slice(11, 16) : "");
  if (!hhmm && m.schedule) {
    const t = m.schedule.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (t) { let h = +t[1]; const ap = (t[3] || "").toUpperCase(); if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0; hhmm = String(h).padStart(2, "0") + ":" + t[2]; }
  }
  if (!hhmm) return Infinity;
  const [h, mn] = hhmm.split(":").map(Number);
  return h * 60 + mn;
}
const STATUS_ORDER = { live: 0, upcoming: 1, final: 2 };
function cmpByStart(a, b) {
  const so = (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3);
  if (so) return so;
  if (a.status === "upcoming") return startMin(a) - startMin(b);
  return 0; // keep feed order within live / final
}

// Prestige tier from a tournament name (Premier Padel + FIP ladder). National
// events have no tier keyword → 0, so they rank by size within their section.
function tournamentTier(name) {
  const s = (name || "").toLowerCase();
  if (/\bmajor\b|\bfinals?\b/.test(s)) return 100;   // Premier Padel Major / Finals
  if (/\bp1\b/.test(s)) return 90;                    // Premier Padel P1
  if (/\bp2\b/.test(s)) return 80;                    // Premier Padel P2
  if (/\bgold\b/.test(s)) return 70;                  // FIP Gold
  if (/\bsilver\b/.test(s)) return 60;                // FIP Silver
  if (/\bbronze\b/.test(s)) return 50;                // FIP Bronze
  if (/promis/.test(s)) return 30;                    // FIP Promises (youth)
  return 0;
}
// Bigger first: tier dominates, match count breaks ties (and orders nationals).
const tournamentRank = (g) => tournamentTier(g.t.name) * 1000 + g.matches.length;

function renderGroups(matches, changed) {
  // group by tournament, preserve aggregate order
  const groups = new Map();
  for (const m of matches) {
    const key = m.source + ":" + m.tournament.id;
    if (!groups.has(key)) groups.set(key, { key, t: m.tournament, fed: m.federation, matches: [] });
    groups.get(key).matches.push(m);
  }
  const arr = [...groups.values()];
  arr.forEach((g) => g.matches.sort(cmpByStart)); // chronological within each event

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
      gs.sort((a, b) => tournamentRank(b) - tournamentRank(a)); // biggest / most prestigious first
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
        <span class="group__title"><span class="tlink" data-tourney="live" data-tkey="${esc(g.key)}" data-tname="${esc(g.t.name)}" data-tfed="${esc(g.fed)}">${esc(g.t.name)}</span></span>
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
      ? `<span class="badge final">Ended</span>`
      : `${followed ? `<span class="foll">Next up</span>` : ""}<span class="badge upcoming">${schedLabel(m) || "Soon"}</span>`;

  return `
    <div class="match ${open ? "open" : ""}" data-match="${esc(m.id)}">
      <div class="match__main" data-open="${esc(m.id)}">
        <div class="match__state">${stateCol}${m.status !== "upcoming" && time ? `<span class="t">${time}</span>` : ""}</div>
        <div class="teams">
          ${showTournament ? `<div class="team"><span class="flag" style="font-size:10px">${FLAGS[m.federation] || ""} ${m.federation}</span><span class="nm" style="color:var(--muted);font-size:12px">${esc(m.tournament.name)}</span></div>` : ""}
          ${m.court ? `<div class="crtline"><span class="crtpin">📍 ${esc(m.court)}</span>${m.round ? ` · ${esc(m.round)}` : ""}</div>` : ""}
          ${teamLine(m, 0, isChanged)}
          ${teamLine(m, 1, isChanged)}
        </div>
      </div>
      ${detail(m)}
    </div>`;
}

// FIP encodes a tie-break set by appending the tie-break points to the 6-games
// side (e.g. "66" = 6 games, tie-break 6 → 7–6⁽⁶⁾). Split games from tie-break.
function setParts(v) {
  const m = /^([67])(\d+)$/.exec(String(v == null ? "" : v));
  return m ? { g: m[1], tb: m[2] } : { g: String(v == null ? "" : v), tb: null };
}
const setCellHtml = (v) => { const { g, tb } = setParts(v); return tb ? `${esc(g)}<sup class="tb">${esc(tb)}</sup>` : esc(g); };
const setCellText = (v) => { const { g, tb } = setParts(v); return tb ? `${g}(${tb})` : g; }; // plain text (SVG bracket)

function teamLine(m, side, isChanged) {
  const t = m.teams[side];
  const win = m.score.winner === side;
  const sets = m.score.sets || [];
  const cells = sets.length
    ? `<div class="sets">${sets.map((s) => `<${win ? "b" : "span"} class="${isChanged ? "flash" : ""}">${setCellHtml(s[side])}</${win ? "b" : "span"}>`).join("")}</div>`
    : side === 0
    ? `<span class="vs">vs</span>`
    : "";
  return `<div class="team ${win ? "win" : ""}"><span class="nm">${esc(t.name)}</span>${cells}</div>`;
}

// "00:38" -> "38 min", "01:15" -> "1h 15m"
function fmtDur(d) {
  const m = /^(\d+):(\d+)/.exec(String(d || ""));
  if (!m) return null;
  const h = +m[1], min = +m[2];
  return h ? `${h}h ${min}m` : min ? `${min} min` : null;
}

function detail(m) {
  const sets = m.score.sets || [];
  const setGrid = sets.length
    ? `<div class="grid">${sets.map((s, i) => `<div class="setcol"><div class="lbl">Set ${i + 1}</div><div class="val">${setCellHtml(s[0])}–${setCellHtml(s[1])}</div></div>`).join("")}</div>`
    : `<div style="margin:6px 0 10px;color:var(--faint)">No score yet.</div>`;
  const dur = fmtDur(m.raw && m.raw.dur);
  const kv = [
    dur && `<span>Duration <b>${esc(dur)}</b></span>`,
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
        <span class="group__title"><span class="tlink" data-tourney="arch" data-tkey="${esc(t.key)}" data-tname="${esc(t.name)}" data-tfed="${esc(t.federation)}">${esc(t.name)}</span></span>
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
  state.h2h = null; state.comparing = false; state.player = "loading"; state.playerId = id;
  render();
  syncUrl(); // /player/<id>
  ensureRankings(); // so the profile can show the player's ranking

  try { state.player = await (await fetch("/api/player/" + encodeURIComponent(id))).json(); } catch { state.player = null; }
  render();
  setTitle(); // now we have the player name
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

// Lazy-load the ranking lists (shared with the Rankings tab) so a profile can
// show the player's ranking, without the skeleton flash loadRankings() causes.
let _ranksLoading = false;
async function ensureRankings() {
  if (state.rankings || _ranksLoading) return;
  _ranksLoading = true;
  const grab = (u) => fetch(u + "?_=" + Date.now()).then((r) => (r.ok ? r.json() : { lists: [] })).catch(() => ({ lists: [] }));
  const [fip, nat] = await Promise.all([grab("data/rankings-fip.json"), grab("data/rankings.json")]);
  state.rankings = { lists: [...(fip.lists || []), ...(nat.lists || [])] };
  _ranksLoading = false;
  if (state.mode === "players" && state.player && state.player !== "loading") render();
}

// Every ranking list this player appears in, best rank first.
function playerRankings(id) {
  if (!state.rankings || !id) return [];
  const out = [];
  for (const l of state.rankings.lists) {
    const row = (l.rows || []).find((r) => r.id === id);
    if (row) out.push({ fed: l.fed, movement: !!l.movement, ...row });
  }
  return out.sort((a, b) => a.rank - b.rank);
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
        ${summary.titles ? `<div class="pstat hi"><b>${summary.titles}</b><span>title${summary.titles === 1 ? "" : "s"}</span></div>` : ""}
        ${summary.finals ? `<div class="pstat"><b>${summary.finals}</b><span>finals</span></div>` : ""}
        ${summary.sets && summary.sets.pct != null ? `<div class="pstat"><b>${summary.sets.pct}%</b><span>sets won</span></div>` : ""}
        ${summary.games && summary.games.pct != null ? `<div class="pstat"><b>${summary.games.pct}%</b><span>games won</span></div>` : ""}
      </div>
    </div>`;
  const form = summary.form || [];
  if (form.length)
    html += `<div class="form-row"><span class="form-lbl">Form</span>${form.map((r) => `<span class="fchip ${r === "W" ? "w" : "l"}">${r}</span>`).join("")}${summary.streak > 1 ? `<span class="streak">${summary.streak} ${summary.streakType === "W" ? "wins" : "losses"} in a row</span>` : ""}</div>`;
  const tp = state.player.topPartner;
  if (tp)
    html += `<div class="toppartner" data-player="${esc(tp.id)}"><span class="tp-lbl">Top partner</span><b>${esc(tp.name)}</b><span class="tp-meta">${tp.matches} matches · ${tp.wins}-${tp.matches - tp.wins}</span></div>`;
  const ranks = playerRankings(player.id);
  if (ranks.length)
    html += `<div class="section-label">Ranking</div><div class="rankcards">` +
      ranks.map((r) => `<div class="rankcard">
        <span class="rc-fed">${FLAGS[r.fed] || ""} ${r.fed === "FIP" ? "FIP world" : (REGION_LABEL[r.fed] || r.fed)}</span>
        <span class="rc-rank">#${r.rank}</span>
        <span class="rc-pts">${r.points != null ? Math.round(r.points).toLocaleString() : ""} pts</span>
        <span class="rc-move">${moveCell(r, r.movement)}</span>
      </div>`).join("") + `</div>`;
  html += `<button class="pcompare ${state.comparing ? "on" : ""}" data-compare="1">⚔️ ${state.comparing ? "Now search an opponent above…" : "Head-to-head vs…"}</button>`;
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
  state.tView = "draw"; // each tournament opens on the draw; user can switch to By day
  state.tournament = { kind, key, name, fed, matches: kind === "live" ? null : "loading" };
  syncUrl(); // /tournament/<source>/<id>
  if (kind === "arch") {
    if (state.archiveData.has(key)) {
      state.tournament.matches = state.archiveData.get(key).matches;
    } else {
      render(); // shows skeleton
      fetch(`data/archive/t/${key}.json`)
        .then((r) => r.json())
        .then((d) => {
          state.archiveData.set(key, d);
          if (state.tournament && state.tournament.key === key) {
            state.tournament.matches = d.matches;
            if (d.name) state.tournament.name = d.name;       // backfill for deep-links opened without the index
            if (d.federation) state.tournament.fed = d.federation;
          }
          render(); setTitle();
        })
        .catch(() => { if (state.tournament) state.tournament.matches = []; render(); });
      return;
    }
  }
  try { window.scrollTo(0, 0); } catch {}
  render();
}

// ---- knockout bracket ------------------------------------------------------
const isKO = (r) => { const rk = roundRank(r); return rk >= 50 && rk <= 100 && rk !== 85; };

// Reconstruct the single-elim tree from flat matches: a match in round r+1 is fed
// by the round-r matches its two teams came from (team names are identical across
// rounds within a tournament). Then lay it out with a DFS from the final.
function buildBracket(matches) {
  const ko = matches.filter((m) => isKO(m.round));
  const byRound = new Map();
  for (const m of ko) { if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
  const rounds = [...byRound.entries()].sort((a, b) => roundRank(a[0]) - roundRank(b[0])); // earliest → final
  if (rounds.length < 2) return null;

  const nodeOf = new Map(), nodes = [];
  rounds.forEach(([rn, ms], ri) => ms.forEach((m) => { const n = { m, round: ri, roundName: rn, children: [], cy: 0 }; nodeOf.set(m, n); nodes.push(n); }));
  const tnames = (m) => m.teams.map((t) => (t.name || "").trim()).filter(Boolean);
  for (let ri = 1; ri < rounds.length; ri++) {
    const prevByTeam = new Map();
    for (const pm of rounds[ri - 1][1]) for (const tn of tnames(pm)) prevByTeam.set(tn, pm);
    for (const m of rounds[ri][1]) {
      const node = nodeOf.get(m);
      for (const tn of tnames(m)) {
        const f = prevByTeam.get(tn);
        if (f && f !== m) node.children.push(nodeOf.get(f));
        else {
          // This team didn't play the previous round — a seed on a bye. Add a
          // placeholder feeder so the match still has two children and the
          // layout centres into a proper pyramid (standard bracket convention).
          const bye = { m: null, round: ri - 1, roundName: rounds[ri - 1][0], children: [], cy: 0, bye: true, teamName: tn };
          nodes.push(bye);
          node.children.push(bye);
        }
      }
      node.children = [...new Set(node.children)];
    }
  }

  // Live/partial draws: a match whose winner's next match isn't in the feed yet
  // would dangle with no line out. Give it a "TBD" placeholder parent so it still
  // connects forward into the bracket instead of floating.
  const pointed = new Set();
  for (const n of nodes) for (const c of n.children) pointed.add(c);
  const lastRi = rounds.length - 1;
  for (const n of nodes.filter((n) => n.m && n.round < lastRi && !pointed.has(n))) {
    nodes.push({ m: null, round: n.round + 1, roundName: rounds[n.round + 1][0], children: [n], cy: 0, tbd: true });
  }

  const SLOT = 58;
  let slot = 0; const seen = new Set();
  const place = (n) => {
    if (seen.has(n)) return n.cy; seen.add(n);
    if (!n.children.length) { n.cy = slot * SLOT + SLOT / 2; slot++; return n.cy; }
    const ys = n.children.map(place);
    n.cy = (Math.min(...ys) + Math.max(...ys)) / 2; return n.cy;
  };
  const hasParent = new Set();
  for (const n of nodes) for (const c of n.children) hasParent.add(c);
  for (const r of nodes.filter((n) => !hasParent.has(n))) place(r); // every root: real finals + TBD stubs
  for (const n of nodes) if (!seen.has(n)) { seen.add(n); n.cy = slot * SLOT + SLOT / 2; slot++; }
  return { rounds: rounds.map((r) => r[0]), nodes, slots: slot, SLOT };
}

function renderBracket(b) {
  const COL_W = 202, BOX_W = 178, BOX_H = 46, HEAD = 26, PAD = 8;
  const W = b.rounds.length * COL_W + PAD;
  const H = HEAD + b.slots * b.SLOT + PAD;
  const xOf = (r) => r * COL_W + PAD / 2;
  const trunc = (s, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const roundShort = (r) => r.replace(/^(Men|Women)\s+/i, "").replace(/round of /i, "R").replace(/quarterfinals?/i, "QF").replace(/semifinals?/i, "SF").trim();

  let s = "";
  b.rounds.forEach((rn, i) => { s += `<text class="bk-round" x="${xOf(i) + BOX_W / 2}" y="15" text-anchor="middle">${esc(roundShort(rn))}</text>`; });
  for (const n of b.nodes) {
    const nx = xOf(n.round), ncy = HEAD + n.cy;
    for (const c of n.children) {
      const cx2 = xOf(c.round) + BOX_W, ccy = HEAD + c.cy, midX = (cx2 + nx) / 2;
      s += `<path class="bk-line" d="M${cx2} ${ccy} H${midX.toFixed(1)} V${ncy.toFixed(1)} H${nx}"/>`;
    }
  }
  const uid = "bk" + (renderBracket._n = (renderBracket._n || 0) + 1) + "_"; // unique clip ids per bracket
  const CHAR = 6.1; // ≈ width of one 11px glyph
  b.nodes.forEach((n, ni) => {
    const x = xOf(n.round), y = HEAD + n.cy - BOX_H / 2;
    if (n.tbd) {
      // Winner of a completed match advances here; opponent not decided yet.
      s += `<g class="bk-box bk-bye">
        <rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="7"/>
        <text class="bk-bye-tag" x="${x + 12}" y="${y + BOX_H / 2 + 4}">TBD · winner advances</text>
      </g>`;
      return;
    }
    if (n.bye) {
      // A seed entering on a bye — a quiet dashed placeholder feeding the next match.
      const clipB = uid + "b" + ni, nameRight = x + BOX_W - 7 - 30;
      s += `<clipPath id="${clipB}"><rect x="${x + 9}" y="${y}" width="${Math.max(8, nameRight - (x + 9))}" height="${BOX_H}"/></clipPath>`;
      s += `<g class="bk-box bk-bye">
        <rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="7"/>
        <text class="bk-t" x="${x + 9}" y="${y + BOX_H / 2 + 4}" clip-path="url(#${clipB})">${esc(trunc(n.teamName, 24))}</text>
        <text class="bk-bye-tag" x="${x + BOX_W - 7}" y="${y + BOX_H / 2 + 4}" text-anchor="end">BYE</text>
      </g>`;
      return;
    }
    const [a, bb] = n.m.teams;
    const w = n.m.score?.winner;
    const sets = n.m.score?.sets || [];
    // Games only in the bracket — keeps it compact; tie-break points show in the match list.
    const sc = (side) => (sets.length ? sets.map((st) => setParts(st[side]).g).join(" ") : "");
    const s0 = sc(0), s1 = sc(1);
    const scoreW = Math.max(s0.length, s1.length) * 7 + 4;      // px reserved for the score
    const nameRight = x + BOX_W - 7 - scoreW;                   // names must stop before the score
    const nameChars = Math.max(4, Math.floor((nameRight - (x + 9)) / CHAR));
    const clip = uid + ni;
    s += `<clipPath id="${clip}"><rect x="${x + 9}" y="${y}" width="${Math.max(8, nameRight - (x + 9))}" height="${BOX_H}"/></clipPath>`;
    s += `<g class="bk-box">
      <rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="7"/>
      <text class="bk-t ${w === 0 ? "win" : ""}" x="${x + 9}" y="${y + 18}" clip-path="url(#${clip})">${esc(trunc(a.name, nameChars))}</text>
      <text class="bk-s ${w === 0 ? "win" : ""}" x="${x + BOX_W - 7}" y="${y + 18}" text-anchor="end">${esc(s0)}</text>
      <text class="bk-t ${w === 1 ? "win" : ""}" x="${x + 9}" y="${y + 37}" clip-path="url(#${clip})">${esc(trunc(bb.name, nameChars))}</text>
      <text class="bk-s ${w === 1 ? "win" : ""}" x="${x + BOX_W - 7}" y="${y + 37}" text-anchor="end">${esc(s1)}</text>
    </g>`;
  });
  return `<div class="bk-wrap"><svg class="bk" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${s}</svg></div>`;
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

  // Offer a "By day" schedule when the matches carry a play-day (FIP) or a date (RankedIn).
  const hasDays = matches.some((m) => matchDay(m));
  const view = hasDays ? (state.tView || "draw") : "draw";
  if (hasDays) {
    html += `<div class="tviews">
      <button class="tvbtn ${view === "draw" ? "on" : ""}" data-tview="draw">Draw</button>
      <button class="tvbtn ${view === "day" ? "on" : ""}" data-tview="day">By day</button>
    </div>`;
  }

  if (!matches.length) { app.innerHTML = html + `<div class="empty">No matches for this event yet.</div>`; return; }

  if (view === "day") {
    html += renderByDay(matches, tv);
  } else {
    // group by category (class) → round, rounds ordered final-first
    const cats = new Map();
    for (const m of matches) {
      const { cls, round } = splitCategory(m);
      if (!cats.has(cls)) cats.set(cls, new Map());
      const rmap = cats.get(cls);
      if (!rmap.has(round)) rmap.set(round, []);
      rmap.get(round).push(m);
    }
    const roundList = (entries) => entries
      .sort((a, b) => roundRank(b[0]) - roundRank(a[0]))
      .map(([round, ms]) => (round ? `<div class="round-label">${esc(round)}</div>` : "") +
        `<div class="group open"><div class="group__body">${ms.map((m) => (tv.kind === "live" ? matchRow(m, new Set(), false) : archiveMatchRow(m))).join("")}</div></div>`)
      .join("");

    for (const [cls, rmap] of cats) {
      if (cls) html += `<div class="section-label region">${esc(cls)}</div>`;
      const bracket = buildBracket([...rmap.values()].flat());
      if (bracket) {
        html += renderBracket(bracket);
        html += roundList([...rmap.entries()].filter(([r]) => !isKO(r))); // groups/qualifying as list
      } else {
        html += roundList([...rmap.entries()]);
      }
    }
  }
  if (players.size) html += `<div class="section-label">Players · ${players.size}</div><div class="tplayers">${[...players].sort().map((p) => `<span class="pchip">${esc(p)}</span>`).join("")}</div>`;
  app.innerHTML = html;
}

// A match's play-day: FIP carries {n,label} from the widget; RankedIn (and any
// dated source) carries a real startTime, from which we derive the calendar day.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateLabel(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  return `${WD[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${MO[mo - 1]}`;
}
function matchDay(m) {
  if (m.day && m.day.n != null) return { key: "d" + m.day.n, sort: m.day.n, n: m.day.n, label: m.day.label };
  if (m.startTime && /^\d{4}-\d{2}-\d{2}/.test(m.startTime)) { const iso = m.startTime.slice(0, 10); return { key: iso, sort: iso, n: null, label: dateLabel(iso) }; }
  return null;
}

// Schedule view: matches grouped by play-day, chronological within a day.
function renderByDay(matches, tv) {
  const byDay = new Map();
  for (const m of matches) {
    const d = matchDay(m);
    const key = d ? d.key : "__tbc";
    if (!byDay.has(key)) byDay.set(key, { sort: d ? d.sort : Infinity, n: d ? d.n : null, label: d ? d.label : null, matches: [] });
    byDay.get(key).matches.push(m);
  }
  const groups = [...byDay.values()].sort((a, b) =>
    a.sort === b.sort ? 0 : a.sort === Infinity ? 1 : b.sort === Infinity ? -1 : a.sort < b.sort ? -1 : 1);
  let out = "", i = 0;
  for (const g of groups) {
    i++;
    const head = g.sort === Infinity ? "Date TBC" : `Day ${g.n != null ? g.n : i}${g.label ? " · " + esc(g.label) : ""}`;
    g.matches.sort(cmpByStart);
    out += `<div class="section-label region">${head}<span class="count">${g.matches.length} match${g.matches.length === 1 ? "" : "es"}</span></div>` +
      `<div class="group open"><div class="group__body">${g.matches.map((m) => (tv.kind === "live" ? matchRow(m, new Set(), false) : archiveMatchRow(m))).join("")}</div></div>`;
  }
  return out;
}

// ---------- competitions overview ----------

// Tournament (knockout draw) vs League (round-robin / team). KO rounds are the
// strongest signal; otherwise fall back to name keywords.
function competitionFormat(name, matches) {
  if (matches.some((m) => isKO(m.round))) return "Tournament";
  if (/\bliga\b|league|extraliga|interclub|\bdivision\b|holdturnering|pool play|\bserie[an]?\b/i.test(name || "")) return "League";
  return "Tournament";
}

// Browse every current competition (tournament or league) from the live feed.
function renderEvents() {
  const comps = new Map();
  for (const m of state.matches) {
    if (state.fed !== "all" && m.federation !== state.fed) continue;
    const key = m.source + ":" + m.tournament.id;
    if (!comps.has(key)) comps.set(key, { key, name: m.tournament.name, source: m.source, fed: m.federation, matches: [], players: new Set() });
    const c = comps.get(key);
    c.matches.push(m);
    for (const t of m.teams) for (const p of (t.name || "").split("/")) { const n = p.trim(); if (n) c.players.add(n); }
  }
  const q = state.query.trim().toLowerCase();
  const list = [...comps.values()].filter((c) => !q || c.name.toLowerCase().includes(q));
  for (const c of list) {
    c.live = c.matches.filter((m) => m.status === "live").length;
    c.upcoming = c.matches.filter((m) => m.status === "upcoming").length;
    c.format = competitionFormat(c.name, c.matches);
  }
  list.sort((a, b) =>
    (b.live > 0) - (a.live > 0) ||
    tournamentTier(b.name) - tournamentTier(a.name) ||
    b.matches.length - a.matches.length ||
    a.name.localeCompare(b.name));

  if (!list.length) {
    app.innerHTML = `<div class="empty"><div class="big">🎾</div>No competitions match.</div>`;
    return;
  }

  const pill = (c) =>
    c.live ? `<span class="ev-pill live"><span class="lampe"></span>${c.live} live</span>`
    : c.upcoming ? `<span class="ev-pill up">${c.upcoming} upcoming</span>`
    : `<span class="ev-pill done">Completed</span>`;
  const card = (c) => `<div class="ev" data-tourney="live" data-tkey="${esc(c.key)}" data-tname="${esc(c.name)}" data-tfed="${esc(c.fed)}">
      <span class="flag">${FLAGS[c.fed] || ""} ${esc(c.fed)}</span>
      <div class="ev-main">
        <div class="ev-name">${esc(c.name)}</div>
        <div class="ev-meta">${c.matches.length} matches · ${c.players.size} players</div>
      </div>
      ${pill(c)}
    </div>`;
  let html = "";
  for (const [label, items] of [["Tournaments", list.filter((c) => c.format === "Tournament")], ["Leagues", list.filter((c) => c.format === "League")]]) {
    if (!items.length) continue;
    const nLive = items.filter((c) => c.live).length;
    html += `<div class="section-label">${label}<span class="count">${items.length}${nLive ? ` · ${nLive} live` : ""}</span></div>` + items.map(card).join("");
  }
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
  state.player = null; state.playerId = null; state.h2h = null; state.playerResults = null; state.comparing = false;
  state.tournament = null;
  state.rankCountryQuery = "";
  document.querySelectorAll("#modes button").forEach((x) => x.classList.toggle("active", x.dataset.mode === mode));
  document.getElementById("tabs").style.display = mode === "live" ? "" : "none";
  document.getElementById("year").hidden = mode !== "archive";
  document.getElementById("chips").style.display = mode === "live" || mode === "archive" || mode === "events" ? "" : "none";
  const qEl = document.getElementById("q");
  qEl.value = "";
  qEl.closest(".search").style.display = mode === "favorites" ? "none" : "";
  qEl.placeholder =
    mode === "players" ? "Search a player by name…" :
    mode === "rankings" ? "Filter this ranking…" :
    mode === "events" ? "Search competitions…" :
    mode === "archive" ? "Search tournament…" : "Search player or tournament…";
  if (mode === "archive" && !state.archive) loadArchive();
  else if (mode === "rankings" && !state.rankings) loadRankings();
  else render();
  syncUrl();
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
  if (e.target.closest("[data-tback]")) { state.tournament = null; render(); syncUrl(); return; }
  const tvw = e.target.closest("[data-tview]");
  if (tvw) { state.tView = tvw.dataset.tview; render(); return; }

  // push alerts enable/disable
  const pb = e.target.closest("[data-push]");
  if (pb) { pb.dataset.push === "on" ? enablePush() : disablePush(); return; }

  // rankings: federation / category selector
  const rf = e.target.closest("[data-rfed]");
  if (rf) { state.rankFed = rf.dataset.rfed; render(); syncUrl(false); return; }
  const rc = e.target.closest("[data-rcat]");
  if (rc) { state.rankCat = rc.dataset.rcat; render(); syncUrl(false); return; }

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
    else { state.player = null; state.playerId = null; }
    render();
    syncUrl();
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
const themeMeta = document.querySelector('meta[name="theme-color"]');
// Keep the browser chrome (theme-color) matched to whatever theme is actually showing.
const syncThemeColor = () => {
  const eff = document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  if (themeMeta) themeMeta.content = eff === "light" ? "#f4f6fa" : "#0e1014";
};
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; syncThemeColor(); };
applyTheme(localStorage.getItem("pls-theme"));
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  const isDark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = isDark ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem("pls-theme", next);
});
// With no manual override, follow system light/dark changes for the chrome too.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!document.documentElement.dataset.theme) syncThemeColor();
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

// ---------- install prompt (PWA) ----------
// Android/desktop: capture the native beforeinstallprompt and offer an Install
// button. iOS Safari: show the manual "Add to Home Screen" hint (no such event).
// Auto-hidden when already installed or recently dismissed.
(function installPrompt() {
  const bar = document.getElementById("installbar");
  if (!bar) return;
  const KEY = "pt-install-dismissed";
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const dismissed = () => { try { return Date.now() - (+localStorage.getItem(KEY) || 0) < 30 * 864e5; } catch { return false; } };
  let deferred = null;

  const show = (kind) => {
    if (standalone() || dismissed()) return;
    bar.innerHTML = kind === "ios"
      ? `<span>📲 Add <b>PadelTicker</b> to your Home Screen — tap the Share icon, then “Add to Home Screen”.</span><button class="ib-x" data-install="dismiss" aria-label="Dismiss">✕</button>`
      : `<span>📲 Install <b>PadelTicker</b> for one-tap access${"Notification" in window ? " &amp; live alerts" : ""}.</span><button class="ib-btn" data-install="go">Install</button><button class="ib-x" data-install="dismiss" aria-label="Dismiss">✕</button>`;
    bar.hidden = false;
  };
  const hide = () => { bar.hidden = true; };

  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; show("android"); });
  window.addEventListener("appinstalled", () => { deferred = null; hide(); });

  bar.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-install]");
    if (!b) return;
    if (b.dataset.install === "dismiss") { try { localStorage.setItem(KEY, String(Date.now())); } catch {} hide(); return; }
    if (b.dataset.install === "go" && deferred) { deferred.prompt(); try { await deferred.userChoice; } catch {} deferred = null; hide(); }
  });

  // iOS Safari has no beforeinstallprompt — show the manual hint.
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios|edgios|chrome/i.test(ua) && !standalone()) show("ios");
})();

// ---------- routing (SEO-friendly, deep-linkable URLs) ----------
// Views get real URLs so they're shareable, back-button-able and crawlable, and
// the document title updates per view. Server-side per-entity meta (for social
// scrapers that don't run JS) is layered on via Pages Functions.
let _routing = false; // suppress URL writes while applying a route from the URL
// key → URL path. Live keys are "source:id", archive keys are "source-id";
// split on whichever separates the source so both become "source/id".
const tournamentUrlKey = (key) => {
  const ci = key.indexOf(":");
  if (ci >= 0) return key.slice(0, ci) + "/" + key.slice(ci + 1);
  const di = key.indexOf("-");
  return di < 0 ? key : key.slice(0, di) + "/" + key.slice(di + 1);
};

function currentPath() {
  if (state.tournament) return "/tournament/" + tournamentUrlKey(state.tournament.key);
  if (state.mode === "players") return state.playerId ? "/player/" + encodeURIComponent(state.playerId) : "/players";
  if (state.mode === "rankings") return state.rankFed ? `/rankings/${state.rankFed}/${state.rankCat || "men"}` : "/rankings";
  if (state.mode === "favorites") return "/following";
  if (state.mode === "archive") return "/results";
  if (state.mode === "events") return "/events";
  return "/";
}

function setTitle() {
  const P = state.player && state.player !== "loading" ? state.player.player : null;
  let t = "PadelTicker — live padel scores";
  if (state.tournament) t = `${state.tournament.name} — draw, results & schedule · PadelTicker`;
  else if (P) t = `${P.name} — padel results, ranking & head-to-head · PadelTicker`;
  else if (state.mode === "rankings" && state.rankFed) t = `${state.rankFed === "FIP" ? "FIP world" : REGION_LABEL[state.rankFed] || state.rankFed} padel ranking${state.rankCat === "women" ? " — women" : ""} · PadelTicker`;
  else if (state.mode === "archive") t = "Padel results & tournament archive · PadelTicker";
  else if (state.mode === "players") t = "Padel players — profiles, results & head-to-head · PadelTicker";
  else if (state.mode === "favorites") t = "Following — your padel players & tournaments · PadelTicker";
  else if (state.mode === "events") t = "Padel tournaments & leagues — live competitions · PadelTicker";
  document.title = t;
}

function syncUrl(push = true) {
  setTitle();
  if (_routing) return;
  const path = currentPath();
  if (location.pathname + location.search === path) return;
  try { history[push ? "pushState" : "replaceState"]({}, "", path); } catch {}
}

function openTournamentRoute(source, id) {
  const liveKey = source + ":" + id;
  const m = state.matches.find((x) => x.source + ":" + x.tournament.id === liveKey);
  if (m) return openTournament("live", liveKey, m.tournament.name, m.federation);
  const archKey = source + "-" + id;
  const at = state.archive?.tournaments?.find((t) => t.key === archKey);
  if (at) return openTournament("arch", archKey, at.name, at.federation);
  openTournament("arch", archKey, archKey, ""); // name/fed backfilled once the archive file loads
}

function applyRoute() {
  _routing = true;
  try {
    const seg = decodeURIComponent(location.pathname).split("/").filter(Boolean);
    const q = new URLSearchParams(location.search);
    if (seg[0] === "player" && seg[1]) { activateMode("players"); openPlayer(seg[1]); }
    else if (seg[0] === "tournament" && seg[1] && seg[2]) { openTournamentRoute(seg[1], seg.slice(2).join("/")); }
    else if (seg[0] === "rankings") {
      activateMode("rankings");
      if (seg[1]) { state.rankFed = seg[1].toUpperCase(); if (seg[2]) state.rankCat = seg[2].toLowerCase(); if (state.rankings) render(); }
    }
    else if (seg[0] === "results") activateMode("archive");
    else if (seg[0] === "events") activateMode("events");
    else if (seg[0] === "players") {
      activateMode("players");
      const qq = q.get("q");
      if (qq) { const el = document.getElementById("q"); el.value = qq; state.query = qq; searchPlayers(qq); }
    }
    else if (seg[0] === "following") activateMode("favorites");
    else activateMode("live");
  } finally { _routing = false; }
  setTitle();
}

window.addEventListener("popstate", applyRoute);

updateFavBadge();
initPush();
app.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
load(false).then(() => { applyRoute(); pollLoop(); });
// keep the "updated Xs ago" label ticking
setInterval(renderControls, 15_000);
