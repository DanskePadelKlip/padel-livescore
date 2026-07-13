// Padel Livescore — P2 UX. Dependency-free.
// Data source: data/matches.json (produced by scripts/fetch-live.js).
// Features: Live Now section, status/country/search filters, collapsible
// tournament groups (keeps the DOM light), tap-to-expand match detail,
// auto-refresh polling with score-change flashing.

// Adaptive polling: near-real-time while a match is live, lazy when nothing's on.
const POLL_LIVE = 20_000;     // ≥1 live match  -> poll fast
const POLL_UPCOMING = 90_000; // matches upcoming -> moderate
const POLL_IDLE = 300_000;    // nothing on      -> back off (5 min)
const FLAGS = { FIP: "🌍", DK: "🇩🇰", SE: "🇸🇪", DE: "🇩🇪", CZ: "🇨🇿", NO: "🇳🇴", FI: "🇫🇮", FR: "🇫🇷" };
const SOURCE_LABEL = { rankedin: "RankedIn", tournamentsoftware: "tournamentsoftware.com", fip: "padelfip.com" };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
        <span class="group__title">${esc(g.t.name)}</span>
        <span class="group__meta">
          ${nLive ? `<span class="badge live">${nLive} live</span>` : ""}
          <span class="count">${g.matches.length}</span>
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

function matchRow(m, changed, showTournament) {
  const open = state.openMatches.has(m.id);
  const isChanged = changed.has(m.id);
  const time = m.startTime ? m.startTime.slice(11, 16) : "";
  const stateCol =
    m.status === "live"
      ? `<span class="lampe"></span><span class="badge live">Live</span>`
      : m.status === "final"
      ? `<span class="badge final">Final</span>`
      : `<span class="badge upcoming">${time || "Soon"}</span>`;

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
        <span class="group__title">${esc(t.name)}</span>
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

// mode switch: Live <-> Results archive
document.getElementById("modes").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.dataset.mode === state.mode) return;
  state.mode = b.dataset.mode;
  state.fed = "all"; // federation sets differ between live and archive
  document.querySelectorAll("#modes button").forEach((x) => x.classList.toggle("active", x === b));
  document.getElementById("tabs").style.display = state.mode === "live" ? "" : "none";
  document.getElementById("year").hidden = state.mode !== "archive";
  document.getElementById("q").value = "";
  state.query = "";
  document.getElementById("q").placeholder = state.mode === "archive" ? "Search tournament…" : "Search player or tournament…";
  if (state.mode === "archive" && !state.archive) loadArchive();
  else render();
});

document.getElementById("year").addEventListener("change", (e) => {
  state.archiveYear = e.target.value;
  state.archiveCap = 40;
  render();
});

let qTimer;
document.getElementById("q").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.query = e.target.value; if (state.mode === "archive") state.archiveCap = 40; render(); }, 180);
});

app.addEventListener("click", (e) => {
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

app.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
load(false).then(pollLoop);
// keep the "updated Xs ago" label ticking
setInterval(renderControls, 15_000);
