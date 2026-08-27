// Padel Livescore — P2 UX. Dependency-free.
// Data source: data/matches.json (produced by scripts/fetch-live.js).
// Features: Live Now section, status/country/search filters, collapsible
// tournament groups (keeps the DOM light), tap-to-expand match detail,
// auto-refresh polling with score-change flashing.

// Adaptive polling: near-real-time while a match is live, lazy when nothing's on.
const POLL_LIVE = 20_000;     // ≥1 live match  -> poll fast
const POLL_UPCOMING = 90_000; // matches upcoming -> moderate
const POLL_IDLE = 300_000;    // nothing on      -> back off (5 min)
const FLAGS = { FIP: "🌍", DK: "🇩🇰", SE: "🇸🇪", DE: "🇩🇪", CZ: "🇨🇿", NO: "🇳🇴", GB: "🇬🇧", AU: "🇦🇺", FI: "🇫🇮", FR: "🇫🇷", HR: "🇭🇷", EE: "🇪🇪", GE: "🇬🇪", HU: "🇭🇺", UA: "🇺🇦", SI: "🇸🇮", XK: "🇽🇰", BA: "🇧🇦", ME: "🇲🇪" };

// Player nationality → flag. Data uses two schemes: 2-letter federation codes
// (national rankings/matches: "dk") and 3-letter IOC/FIP codes (FIP world: "ESP").
// Map the 3-letter ones to ISO alpha-2, then build the flag from regional-indicator
// letters. Unknown codes render no flag (better than a wrong one).
const IOC2 = { ESP:"ES", ARG:"AR", BRA:"BR", UAE:"AE", ITA:"IT", PAR:"PY", POR:"PT", CHI:"CL", CHL:"CL", BEL:"BE", FRA:"FR", NED:"NL", NLD:"NL", SWE:"SE", MEX:"MX", GER:"DE", DEU:"DE", GBR:"GB", ENG:"GB", EGY:"EG", CHN:"CN", USA:"US", URU:"UY", DEN:"DK", TUN:"TN", JPN:"JP", HUN:"HU", GRE:"GR", INA:"ID", IDN:"ID", VEN:"VE", NOR:"NO", FIN:"FI", POL:"PL", AUT:"AT", SUI:"CH", CHE:"CH", CZE:"CZ", SVK:"SK", CRO:"HR", HRV:"HR", SRB:"RS", ROU:"RO", RUS:"RU", UKR:"UA", TUR:"TR", ISR:"IL", IND:"IN", AUS:"AU", CAN:"CA", COL:"CO", PER:"PE", ECU:"EC", BOL:"BO", QAT:"QA", KSA:"SA", SAU:"SA", KUW:"KW", BHR:"BH", MAR:"MA", RSA:"ZA", ZAF:"ZA", GEO:"GE", EST:"EE", LAT:"LV", LTU:"LT", SLO:"SI", SVN:"SI", KOS:"XK", BIH:"BA", MNE:"ME", LUX:"LU", IRL:"IE", ISL:"IS", PHI:"PH", PHL:"PH", THA:"TH", SGP:"SG", MAS:"MY", HKG:"HK", TPE:"TW", KOR:"KR", NZL:"NZ", CRC:"CR", GUA:"GT", DOM:"DO", PUR:"PR", PAN:"PA", PRY:"PY", CHN2:"CN" };
const iso2ToFlag = (cc) => cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1f1e6 - 65 + c.charCodeAt(0)));
function countryFlag(code) {
  if (!code) return "";
  const c = String(code).trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) return iso2ToFlag(c);
  if (/^[A-Z]{3}$/.test(c)) { const iso = IOC2[c]; return iso ? iso2ToFlag(iso) : ""; }
  return "";
}
// Flag for a federation/country code: the special map first (FIP -> 🌍), else derive
// from the 2-letter code. Lets country-level discovery surface ANY nation (RO, ZA,
// MD, …) with a flag, without hardcoding every one in FLAGS.
const fedFlag = (c) => FLAGS[c] || countryFlag(c) || "";

// Team display with a flag before each player: "🇪🇸 A. Coello / 🇦🇷 M. Tapia".
// One player per line, the way padelfip and the Premier Padel app both do it.
// Two compound Spanish surnames plus a seeding marker do not fit one phone-width
// line: measured 2026-08-04, 33% of ended names and 41% of live names were
// truncated, worst case 131px of overflow. Stacking ends that, and leaves room
// for a per-player ranking on the row later. NB the flag separator is a
// non-breaking space, so a flag never wraps away from its name.
// ---------- compound surnames: show the name the player actually uses ----------
// A Spanish pro carries both parents' surnames ("M. Barrera De La Fuente"), which
// overflows the name line and gets ellipsised mid-surname. They don't use the full
// string themselves: Marta Barrera de la Fuente is @martabarrera04, Marta Borrero
// Fernández De La Puente posts as "Martita Borrero", Marta Caparrós Maldonado is
// @martacaparros17, Alejandra Salazar Bengoechea is "Ale Salazar" everywhere. Four
// independent confirmations of one rule: keep the FIRST surname, drop the rest.
//
// Gated on country because the convention is not universal — Portuguese practice
// puts the primary surname LAST, so "J. Gomes Dos Santos Fernandes" would very
// likely become the wrong man as "J. Gomes". Neither Portuguese name on the board
// resolves to an Instagram, so there is no evidence to act on and they keep the
// ellipsis: a clipped name is ugly, a confidently wrong one is a lie.
const SPANISH_SURNAME_CC = new Set(["ESP", "ARG", "MEX", "PAR", "CHI", "URU", "COL", "PER",
  "ECU", "VEN", "BOL", "CRC", "GUA", "PAN", "DOM", "CUB", "HON", "NCA", "ESA", "PUR"]);
// Particles bind to the surname that follows them: "Del Cacho", "De La Fuente".
// Only consumed while LEADING, so "Gonzalez San Martin" still yields "Gonzalez"
// rather than swallowing "San" from the second surname.
const SURNAME_PARTICLES = new Set(["de", "del", "la", "las", "los", "da", "das", "do", "dos", "y"]);
const LONG_NAME_CHARS = 20;   // measured: the name line starts overflowing at ~21 chars @375px

// Seed / qualifier the draw appends: "(2)", "(WC)", "(Q)", "(7 - LL)". It is not part
// of the name, and shortening must hand it back — a 2 seed is information a reader uses.
const DRAW_MARKER = /\s*(\((?:\d+|WC|Q|LL|SE|A)(?:\s*-\s*\w+)?\))\s*$/i;

function shortenSurname(name, country) {
  const raw = String(name || "").trim();
  if (raw.length <= LONG_NAME_CHARS || !SPANISH_SURNAME_CC.has(String(country || "").toUpperCase())) return null;
  const mk = DRAW_MARKER.exec(raw);
  const n = mk ? raw.slice(0, mk.index).trim() : raw;
  const tail = mk ? " " + mk[1] : "";
  const m = /^(\S\.)\s+(.+)$/.exec(n);          // FIP form: "M. Barrera De La Fuente"
  if (!m) return null;
  const toks = m[2].split(/\s+/);
  if (toks.length < 2) return null;
  const keep = [];
  for (const t of toks) {
    keep.push(t);
    if (!SURNAME_PARTICLES.has(t.toLowerCase().replace(/[^a-záéíóúñü-]/gi, ""))) break;
  }
  const short = `${m[1]} ${keep.join(" ")}${tail}`;
  return short.length < raw.length ? short : null;
}

// The globe says what the number IS. Without it the superscript is a bare digit
// beside a name, explained only by a `title` — which a phone never shows. Same 🌍
// the profile's ranking card uses for "FIP world".
const rkHtml = (rk) =>
  rk ? `<sup class="plrk" title="FIP world ranking"><span class="plrk-g">🌍</span>${rk}</sup>` : "";

function teamNameWithFlags(t) {
  if (t.players && t.players.length) {
    return t.players.map((p) => {
      const f = countryFlag(p.country);
      // Only the DISPLAY is shortened. data-pname keeps the full name because that is
      // what /api/search resolves a click against, and the title still spells it out.
      const shown = shortenSurname(p.name, p.country) || p.name;
      const nm = p.name && p.name !== "TBD"
        ? `<span class="pn" data-pname="${esc(p.name)}" title="View ${esc(p.name)}">${esc(shown)}</span>`
        : esc(p.name);
      const rk = rankFor(p.name, p.country);
      return `<span class="pl">${f ? f + " " : ""}${nm}${rkHtml(rk)}</span>`;
    }).join("");
  }
  return `<span class="pl">${esc(t.name)}</span>`;
}
// ---------- world rank on the match row ----------
// A slim name->rank map (42 KB brotli) rather than the full ranking file, which
// is ~145 KB and carries points/movement/slugs the feed has no use for. Loaded
// lazily after first paint: scores must never wait on it.
let RANKS = null;
async function loadRanksLite() {
  if (RANKS) return;
  try { RANKS = (await (await fetch("data/ranks-lite.json?_=" + Date.now())).json()).ranks || {}; }
  catch { RANKS = {}; }
  render();
}
// The live feed sometimes carries a fuller surname than the ranking does
// ("M. Borrero Fernandez De La Puente" vs "M. Borrero"), so try the whole name
// first and then drop trailing surname tokens. Country must match, which is what
// keeps two same-initial namesakes apart.
function rankFor(name, country) {
  if (!RANKS || !country) return null;
  const cc = String(country).toUpperCase();
  const toks = String(name || "").trim().split(/\s+/);
  for (let i = toks.length; i >= 2; i--) {
    const hit = RANKS[normName(toks.slice(0, i).join(" ")) + "|" + cc];
    if (hit) return hit;
  }
  return null;
}

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
  day: "all",                // "all" | "YYYY-MM-DD" — day-strip filter (live feed)
  query: "",
  expandedGroups: new Set(), // tournament ids
  groupCap: new Map(),       // tournament id -> max rows rendered
  openMatches: new Set(),    // match ids
  matchup: new Map(),        // match id -> "loading" | matchup data | null (nothing found)
  scoreSig: new Map(),       // id -> score signature (for flash)
  firstRender: true,
  // ---- archive (historic results) ----
  mode: "live",              // "live" | "archive"
  archive: null,             // loaded index.json
  archiveYear: "all",
  archiveMonth: "all",       // "all" | "01".."12" — month sub-filter within a year
  archiveTour: "all",        // within FIP: "all" | "FIP" | "WPT"
  archiveCap: 40,
  openArchive: new Set(),    // expanded tournament keys
  archiveData: new Map(),    // key -> loaded tournament {matches}
  wptIndex: new Map(),       // wpt key -> archive list row (World Padel Tour, own file)
  wptRankings: {},           // year -> { Men:[…], Women:[…] } end-of-season standings
  profileTours: new Set(),   // profile view: tournament names to filter matches to (empty = all)
  // ---- players (profiles / search / h2h) ----
  playerResults: null,       // search results
  player: null,              // loaded profile
  playerId: null,            // id of the open/loading profile (for the URL)
  h2h: null,                 // loaded head-to-head
  comparing: false,          // in "pick an opponent" mode
  // ---- upcoming (curated pro calendar) ----
  calendar: null,            // loaded calendar.json
  // ---- rankings ----
  rankings: null,            // loaded rankings.json
  rankFed: null,
  rankCat: null,
  rankNat: "",               // "" = all; else a country code to filter a ranking to that nationality
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

// ---------- dates (day strip) ----------

// Local YYYY-MM-DD for a Date (calendar day, not UTC — matches how event times read).
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayYmd = () => ymd(new Date());
state.day = todayYmd();   // default the live feed to today's matches (user can tap "All" or another day)
const MON3 = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const WD3 = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// Normalize a match to its calendar day (YYYY-MM-DD), or null. Two source shapes:
// RankedIn/tournamentsoftware carry an ISO `startTime`; FIP carries a `day.label`
// like "JUL 16 THU" (no year) — infer the year by matching its weekday, so the
// same label resolves correctly across a year boundary. Memoized on the match.
function matchDate(m) {
  if (m._date !== undefined) return m._date;
  let out = null;
  if (m.startTime && /^\d{4}-\d{2}-\d{2}/.test(m.startTime)) {
    out = m.startTime.slice(0, 10);
  } else if (m.day && m.day.label) {
    const mm = m.day.label.toUpperCase().match(/([A-Z]{3})\s+(\d{1,2})(?:\s+([A-Z]{3}))?/);
    if (mm && MON3[mm[1]] != null) {
      const mo = MON3[mm[1]], day = +mm[2], wd = mm[3];
      const now = new Date();
      let best = null;
      for (const y of [now.getFullYear(), now.getFullYear() - 1, now.getFullYear() + 1]) {
        const dt = new Date(y, mo, day);
        if (wd && WD3[dt.getDay()] !== wd) continue;               // weekday must match the label
        if (!best || Math.abs(dt - now) < Math.abs(best - now)) best = dt;
      }
      out = ymd(best || new Date(now.getFullYear(), mo, day));
    }
  }
  m._date = out;
  return out;
}

// ---------- filtering ----------

function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.matches.filter((m) => {
    if (state.status !== "all" && m.status !== state.status) return false;
    if (state.fed !== "all" && m.federation !== state.fed) return false;
    if (state.day !== "all" && matchDate(m) !== state.day) return false;
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
  if (state.mode === "upcoming") return renderUpcoming();
  if (state.mode === "events") return renderEvents();
  if (state.mode === "favorites") return renderFavorites();
  if (state.mode === "rankings") return renderRankings();
  if (state.mode === "players") return renderPlayers();
  if (state.mode === "archive") return renderArchive();
  if (state.mode === "no1") return renderNo1();

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
    let msg = `No ${state.status === "all" ? "" : state.status + " "}matches${state.query ? " for “" + esc(state.query) + "”" : ""}`;
    let hint = "";
    if (state.day !== "all" && !state.query) {
      const [, mo, d] = state.day.split("-");
      msg = `No matches ${state.day === todayYmd() ? "today" : "on " + d + "." + mo}`;
      hint = `<div class="empty-hint">Tap <b>All days</b> or pick a day with matches above.</div>`;
    }
    html = `<div class="empty"><div class="big">🎾</div>${msg}.${hint}</div>`;
  }
  app.innerHTML = html;
}

// Federation → section label (FIP grouped as one "international" section).
const REGION_LABEL = {
  FIP: "FIP International", DK: "Denmark", SE: "Sweden", NO: "Norway",
  DE: "Germany", CZ: "Czechia", GB: "Great Britain", AU: "Australia", FI: "Finland", FR: "France",
  HR: "Croatia", EE: "Estonia", GE: "Georgia",
  HU: "Hungary", UA: "Ukraine", SI: "Slovenia", XK: "Kosovo", BA: "Bosnia", ME: "Montenegro",
  // countries surfaced by RankedIn's global padel calendar (country-level discovery)
  RO: "Romania", MD: "Moldova", ZA: "South Africa", AT: "Austria", CH: "Switzerland",
  PL: "Poland", LT: "Lithuania", LV: "Latvia", SK: "Slovakia", RS: "Serbia", BG: "Bulgaria",
  GR: "Greece", PT: "Portugal", NL: "Netherlands", BE: "Belgium", IE: "Ireland", IT: "Italy",
  ES: "Spain", TH: "Thailand", TR: "Türkiye", CY: "Cyprus", MT: "Malta", LU: "Luxembourg",
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

  // biggest / most prestigious first, within each section
  ordered.forEach(([, gs]) => gs.sort((a, b) => tournamentRank(b) - tournamentRank(a)));

  // auto-expand only live groups + the first one *as displayed* (keeps the DOM
  // light), until the user starts toggling groups themselves. Must run after the
  // section + prestige sort above: indexing the raw feed order opened whichever
  // event the aggregator happened to emit first, so on a day with no live
  // matches an FIP Bronze could sit expanded under a collapsed FIP Gold.
  if (!state._touched) {
    ordered.flatMap(([, gs]) => gs).forEach((g, i) => {
      const hasLive = g.matches.some((m) => m.status === "live");
      if (hasLive || i === 0) state.expandedGroups.add(g.key);
    });
  }

  return ordered
    .map(([fed, gs]) => {
      const n = gs.reduce((s, g) => s + g.matches.length, 0);
      const header =
        `<div class="section-label region"><span class="rflag">${fedFlag(fed)}</span>${esc(REGION_LABEL[fed] || fed)}` +
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
      // Compact tick, not a full "ENDED" pill: the pill held a 46px column open
      // on every finished row, and finished rows are most of the board — that
      // width was coming straight out of the player names.
      ? `<span class="badge final mini" title="Ended" aria-label="Ended">✓</span>`
      : `${followed ? `<span class="foll">Next up</span>` : ""}<span class="badge upcoming">${schedLabel(m) || "Soon"}</span>`;

  return `
    <div class="match ${open ? "open" : ""}" data-match="${esc(m.id)}">
      <div class="match__main${m.status === "final" ? " ended" : ""}" data-open="${esc(m.id)}">
        <div class="match__state">${stateCol}${m.status !== "upcoming" && time ? `<span class="t">${time}</span>` : ""}</div>
        <div class="teams">
          ${showTournament ? `<div class="team"><span class="flag" style="font-size:10px">${fedFlag(m.federation)} ${m.federation}</span><span class="nm" style="color:var(--muted);font-size:12px">${esc(m.tournament.name)}</span></div>` : ""}
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
  // Serve + current game score, where the source publishes them (FIP's live
  // board). The dot slot is rendered on BOTH rows whenever a server is known, so
  // the names don't shift sideways when the serve changes hands mid-game.
  const live = m.status === "live";
  const srv = live && m.score.serving != null
    ? `<span class="srv ${m.score.serving === side ? "on" : ""}"${m.score.serving === side ? ' title="Serving" aria-label="Serving"' : ' aria-hidden="true"'}></span>`
    : "";
  const pt = live && m.score.points ? m.score.points[side] : null;
  // no flash here: isChanged tracks SET changes, and flashing the point cell on
  // a set change (but not on the point changes it actually shows) reads as a bug.
  const pts = pt != null && pt !== "" ? `<span class="pts">${esc(pt)}</span>` : "";
  return `<div class="team ${win ? "win" : ""}">${srv}<span class="nm">${teamNameWithFlags(t)}</span>${cells}${pts}</div>`;
}

// "00:38" -> "38 min", "01:15" -> "1h 15m"
// FIP sometimes publishes a duration that cannot be true: the Aug-6 Round of 16
// that went 3-6 6-3 4-6 (28 games) is reported by the widget as "00:09", and we
// were faithfully printing "9 min". Their referee app was presumably started
// late. Print nothing rather than a wrong fact - the floor is deliberately
// generous (0.6 min/game) so a genuinely quick 6-0 6-0 still shows.
function plausibleDur(d, sets) {
  const m = /^(\d+):(\d+)/.exec(String(d || ""));
  if (!m) return d;
  const mins = +m[1] * 60 + +m[2];
  const games = (sets || []).reduce(
    (n, s) => n + (parseInt(setParts(s[0]).g, 10) || 0) + (parseInt(setParts(s[1]).g, 10) || 0), 0);
  return games && mins < games * 0.6 ? null : d;
}

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
  const dur = fmtDur(plausibleDur(m.raw && m.raw.dur, sets));
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
      ${followPlayers(m)}
      ${matchupHtml(m)}
      <a class="src" href="${esc(m.tournament.url)}" target="_blank" rel="noopener">↗ View on ${esc(SOURCE_LABEL[m.source] || m.source)}</a>
    </div>`;
}

// Follow either player from the match itself. Players and tournaments were
// already followable, but only from the Players / Rankings / profile screens —
// so the Live feed, the one screen people actually watch, was the one place you
// could follow the tournament but not the pair playing in it.
// Keyed by name (favKey's documented fallback): the live feed carries no player
// ids, and matchInvolvesFav resolves follows by surname anyway.
function followPlayers(m) {
  const ps = m.teams.flatMap((t) => t.players || []).filter((p) => p.name && p.name !== "TBD");
  if (!ps.length) return "";
  return `<div class="followrow"><span class="fllbl">Follow</span>${ps
    .map((p) => {
      const f = countryFlag(p.country);
      return `<span class="flp">${f ? f + " " : ""}${esc(p.name)}${star("players", null, p.name, p.country || "")}</span>`;
    })
    .join("")}</div>`;
}

// ---------- head-to-head on a match ----------
// The live feed carries names but no player ids, so a match has to be matched to the
// profile database by name before any history can be shown. Measured Aug 2026: ~84% of
// FIP names resolve once seeding markers are stripped; RankedIn and TournamentSoftware
// are close to nil because those players aren't in D1 yet. When a side can't be
// resolved the block isn't rendered at all, rather than showing an empty shell.

// "J. Zamora Perez (6)" / "Danut Cuc [4]" -> the bare name
function cleanPlayerName(n) {
  return String(n || "")
    .replace(/\[[^\]]*\]/g, " ")               // [4] seeding
    .replace(/\((?:Q|WC|LL|Alt|SE)\)/gi, " ")  // qualifier / wildcard markers
    .replace(/\(\d+\)/g, " ")                  // (6) seeding
    .replace(/\s+/g, " ")
    .trim();
}

const nameIdCache = new Map(); // cleaned lower-case name -> player id | null

async function resolvePlayerId(rawName) {
  const name = cleanPlayerName(rawName);
  if (!name) return null;
  const key = name.toLowerCase();
  if (nameIdCache.has(key)) return nameIdCache.get(key);

  let id = null;
  try {
    const hit = (await (await fetch("/api/search?q=" + encodeURIComponent(name))).json()).players || [];
    const exact = hit.filter((p) => (p.name || "").toLowerCase() === key);
    if (exact.length) id = exact[0].id;

    // FIP abbreviates the first name ("J. Zamora Perez"), which never matches a stored
    // full name. Retry on the surname and accept only an unambiguous initial match.
    if (!id) {
      const ab = /^([\p{L}])\.?\s+(.+)$/u.exec(name);
      if (ab) {
        const initial = ab[1].toLowerCase(), surname = ab[2].toLowerCase();
        const alt = (await (await fetch("/api/search?q=" + encodeURIComponent(ab[2]))).json()).players || [];
        const cands = alt.filter((p) => {
          const pn = (p.name || "").toLowerCase();
          return pn.endsWith(" " + surname) && pn.startsWith(initial);
        });
        if (cands.length === 1) id = cands[0].id;
      }
    }
  } catch { /* offline or no profile db — fall through to null */ }

  nameIdCache.set(key, id);
  return id;
}

async function loadMatchup(m) {
  if (state.matchup.has(m.id)) return; // already loaded, loading, or known-empty
  state.matchup.set(m.id, "loading");
  render();
  try {
    const t0 = (m.teams && m.teams[0] && m.teams[0].players) || [];
    const t1 = (m.teams && m.teams[1] && m.teams[1].players) || [];
    const [a1, a2, b1, b2] = await Promise.all([
      resolvePlayerId(t0[0] && t0[0].name), resolvePlayerId(t0[1] && t0[1].name),
      resolvePlayerId(t1[0] && t1[0].name), resolvePlayerId(t1[1] && t1[1].name),
    ]);
    if ((!a1 && !a2) || (!b1 && !b2)) { state.matchup.set(m.id, null); render(); return; }
    const qs = new URLSearchParams();
    if (a1) qs.set("a1", a1);
    if (a2) qs.set("a2", a2);
    if (b1) qs.set("b1", b1);
    if (b2) qs.set("b2", b2);
    const d = await (await fetch("/api/matchup?" + qs)).json();
    state.matchup.set(m.id, d && !d.error ? d : null);
  } catch { state.matchup.set(m.id, null); }
  render();
}

function recordRow(label, left, right, sub) {
  return `<div class="h2hrow">
    <span class="h2hlbl">${label}</span>
    <span class="h2hnum"><b>${left}</b>–<b>${right}</b></span>
    ${sub ? `<span class="h2hsub">${sub}</span>` : ""}
  </div>`;
}

function matchupHtml(m) {
  const d = state.matchup.get(m.id);
  if (d === undefined) return "";
  if (d === "loading") return `<div class="h2h"><div class="h2hhead">Head-to-head</div><div class="h2hnone">Looking it up…</div></div>`;
  if (!d) return "";

  const nm = (id) => (d.players && d.players[id] && d.players[id].name) || "";
  // FIP already abbreviates ("F. Luis Lopez") — only shorten a full first name, and
  // keep every remaining part so a two-word surname survives.
  const short = (s) => {
    const p = String(s || "").trim().split(/\s+/);
    if (p.length < 2 || /^\p{L}\.$/u.test(p[0])) return s;
    return `${p[0][0]}. ${p.slice(1).join(" ")}`;
  };
  const teamLabel = (side) => (m.teams[side] && m.teams[side].players || []).map((p) => short(cleanPlayerName(p.name))).join(" / ");

  const bits = [];

  // exact pair vs pair
  if (d.pair && d.pair.n) {
    const p = d.pair;
    const lead = p.aWins === p.bWins ? "All square" :
      `${esc(teamLabel(p.aWins > p.bWins ? 0 : 1))} lead`;
    bits.push(`<div class="h2hlead">${lead} <b>${Math.max(p.aWins, p.bWins)}–${Math.min(p.aWins, p.bWins)}</b>
      <span class="h2hsub">as a pair · ${p.n} meeting${p.n === 1 ? "" : "s"}</span></div>`);
    if (p.sets.a + p.sets.b)
      bits.push(recordRow("Sets", p.sets.a, p.sets.b, `games ${p.games.a}–${p.games.b}`));
    bits.push(`<div class="h2hlist">${p.list.map((x) => `
      <div class="h2hm">
        <span class="h2hres ${x.aWon ? "w" : "l"}">${x.aWon ? "W" : "L"}</span>
        <span class="h2hsc">${esc(x.score || "")}</span>
        <span class="h2hmeta">${esc([x.date ? x.date.slice(0, 10) : "", x.tournament, x.round].filter(Boolean).join(" · "))}</span>
      </div>`).join("")}</div>`);
  }

  // player vs player, whoever they partnered
  const cross = (d.cross || []).filter((c) => c.n);
  if (cross.length) {
    bits.push(`<div class="h2hsect">Player vs player</div>`);
    for (const c of cross)
      bits.push(recordRow(`${esc(short(nm(c.a)))} vs ${esc(short(nm(c.b)))}`, c.aWins, c.bWins,
        `${c.n} match${c.n === 1 ? "" : "es"}`));
  }

  // opponents tonight who have played on the same side before
  const exes = (d.cross || []).filter((c) => c.together);
  if (exes.length) {
    bits.push(`<div class="h2hsect">Used to partner</div>`);
    for (const c of exes)
      bits.push(`<div class="h2hrow">
        <span class="h2hlbl">${esc(short(nm(c.a)))} &amp; ${esc(short(nm(c.b)))}</span>
        <span class="h2hnum"><b>${c.together}</b></span>
        <span class="h2hsub">together · won ${c.togetherWins}</span>
      </div>`);
  }

  // how each pair does together
  const pa = d.partners && d.partners.a, pb = d.partners && d.partners.b;
  if ((pa && pa.n) || (pb && pb.n)) {
    bits.push(`<div class="h2hsect">As a partnership</div>`);
    if (pa && pa.n) bits.push(recordRow(esc(teamLabel(0)), pa.wins, pa.n - pa.wins, `${Math.round((pa.wins / pa.n) * 100)}% of ${pa.n}`));
    if (pb && pb.n) bits.push(recordRow(esc(teamLabel(1)), pb.wins, pb.n - pb.wins, `${Math.round((pb.wins / pb.n) * 100)}% of ${pb.n}`));
  }

  if (!bits.length)
    bits.push(`<div class="h2hnone">These two have no shared history on record.</div>`);

  return `<div class="h2h"><div class="h2hhead">Head-to-head</div>${bits.join("")}</div>`;
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
  // In the archive, selecting FIP reveals a second level: which circuit (the FIP /
  // Premier tour, or the historic World Padel Tour). Year, federation and tour are
  // independent, so they can be chosen in any order.
  const showTour = state.mode === "archive" && state.fed === "FIP";
  const key = state.mode + ":" + feds.join(",") + "|fed=" + state.fed + "|tour=" + (showTour ? state.archiveTour : "");
  if (feds.length && chips.dataset.key !== key) {
    chips.dataset.key = key;
    let h =
      `<span class="chip ${state.fed === "all" ? "active" : ""}" data-fed="all">All</span>` +
      feds.map((f) => `<span class="chip ${state.fed === f ? "active" : ""}" data-fed="${f}">${fedFlag(f)} ${f}</span>`).join("");
    if (showTour) {
      // Sub-level: the international bucket splits into the pro-tour ERAS (chronological
      // circuits) — Premier/FIP (modern) → WPT → PPT — each shown with the years it was
      // active. Only eras with data appear.
      const fipT = state.archive.tournaments.filter((t) => t.federation === "FIP");
      const tcount = (v) => (v === "all" ? fipT : fipT.filter((t) => tourOf(t) === v)).length;
      const yrRange = (v) => {
        const ys = (v === "all" ? fipT : fipT.filter((t) => tourOf(t) === v)).map((t) => +archYear(t)).filter(Boolean);
        if (!ys.length) return "";
        const lo = Math.min(...ys), hi = Math.max(...ys);
        return `<span class="cyr">’${String(lo).slice(2)}${lo !== hi ? "–’" + String(hi).slice(2) : ""}</span>`;
      };
      const tours = [["all", "All tours"], ["FIP", "FIP / Premier"], ["WPT", "WPT"], ["PPT", "PPT"]]
        .filter(([v]) => v === "all" || tcount(v) > 0);
      h += `<span class="chipsep"></span>` +
        tours.map(([v, label]) => `<span class="chip sub ${state.archiveTour === v ? "active" : ""}" data-tour="${v}">${label}${v === "all" ? "" : yrRange(v)}<span class="cn">${tcount(v)}</span></span>`).join("");
    }
    chips.innerHTML = h;
  }

  renderDayStrip();

  // refresh label
  if (state.mode === "archive") {
    document.getElementById("refresh-txt").textContent = state.archive ? `${state.archive.count} tournaments` : "loading…";
  } else if (state.meta) {
    document.getElementById("refresh-txt").textContent = `${state.meta.date} · updated ${timeago(new Date(state.meta.generatedAt))}`;
  }
}

// Horizontal day strip: browse the live feed by calendar day. Counts respect the
// active status/fed/search filters (so a day's number = what selecting it shows),
// but NOT the day filter itself. Contiguous window of a recent-lookback .. furthest
// upcoming day, clamped and always including today; empty days are shown dimmed so
// the row reads like a calendar. Additive — "All" stays the default so the feed is
// never silently narrowed to a near-empty single day.
const DAY_LOOKBACK = 9, DAY_LOOKAHEAD = 21;
function renderDayStrip() {
  const strip = document.getElementById("daystrip");
  if (!strip) return;
  // The archive is for browsing HISTORY (the live feed's day strip covers the last
  // few days), so the same strip becomes a prominent one-tap YEAR picker there —
  // it replaced a small <select> that was easy to miss.
  if (state.mode === "archive") {
    if (!state.archive) { strip.style.display = "none"; return; }
    strip.style.display = "";
    const counts = {};
    for (const t of archiveFiltered("year")) { const y = archYear(t); if (y) counts[y] = (counts[y] || 0) + 1; }
    const years = Object.keys(counts).sort().reverse();
    const sig = "y|" + state.fed + "|" + state.archiveTour + "|" + state.query.trim() + "|" + years.map((y) => y + ":" + counts[y]).join(",") + "|sel=" + state.archiveYear;
    if (strip.dataset.sig === sig) return;
    strip.dataset.sig = sig;
    strip.innerHTML =
      `<button class="dchip ychip ${state.archiveYear === "all" ? "active" : ""}" data-year="all"><span class="dw">All</span><span class="dd">years</span></button>` +
      years.map((y) => `<button class="dchip ychip ${state.archiveYear === y ? "active" : ""}" data-year="${y}"><span class="dw">${counts[y]}</span><span class="dd">${y}</span></button>`).join("");
    const focus = strip.querySelector(`.dchip[data-year="${state.archiveYear}"]`);
    if (focus) focus.scrollIntoView({ block: "nearest", inline: "center" });
    return;
  }
  if (state.mode !== "live") { strip.style.display = "none"; return; }
  strip.style.display = "";

  const q = state.query.trim().toLowerCase();
  const counts = {};
  for (const m of state.matches) {
    if (state.status !== "all" && m.status !== state.status) continue;
    if (state.fed !== "all" && m.federation !== state.fed) continue;
    if (q) {
      const hay = (m.tournament.name + " " + m.teams.map((t) => t.name).join(" ") + " " + (m.className || "")).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const d = matchDate(m);
    if (d) counts[d] = (counts[d] || 0) + 1;
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = ymd(today);
  const dayMs = 86400000;
  const dated = Object.keys(counts);
  const clampLo = ymd(new Date(today - DAY_LOOKBACK * dayMs));
  const clampHi = ymd(new Date(today - 0 + DAY_LOOKAHEAD * dayMs));
  let lo = todayStr, hi = todayStr;
  for (const d of dated) {
    if (d >= clampLo && d < lo) lo = d;
    if (d <= clampHi && d > hi) hi = d;
  }

  const days = [];
  for (let t = new Date(lo + "T00:00:00"); ymd(t) <= hi; t = new Date(t - 0 + dayMs)) {
    const ds = ymd(t);
    days.push({ ds, wd: WD3[t.getDay()], dd: `${String(t.getDate()).padStart(2, "0")}.${String(t.getMonth() + 1).padStart(2, "0")}`, n: counts[ds] || 0 });
  }

  const sig = state.status + "|" + state.fed + "|" + q + "|" + days.map((d) => d.ds + ":" + d.n).join(",") + "|sel=" + state.day;
  if (strip.dataset.sig === sig) return;   // no content change -> keep DOM & scroll position
  strip.dataset.sig = sig;

  const chip = (cls, day, wd, dd, num) =>
    `<button class="dchip ${cls}" data-day="${day}"><span class="dw">${wd}</span><span class="dd">${dd}</span>` +
    (num != null ? `<span class="dnum">${num}</span>` : "") + `</button>`;

  let html = chip(state.day === "all" ? "active" : "", "all", "All", "days", null);
  for (const d of days) {
    const cls = [d.ds === todayStr ? "today" : "", d.n === 0 ? "off" : "", state.day === d.ds ? "active" : ""].filter(Boolean).join(" ");
    html += chip(cls, d.ds, d.ds === todayStr ? "Today" : d.wd, d.dd, d.n || null);
  }
  strip.innerHTML = html;

  // bring today (or the selected day) into view without yanking the whole page
  const focus = strip.querySelector(`.dchip[data-day="${state.day !== "all" ? state.day : todayStr}"]`);
  if (focus) focus.scrollIntoView({ block: "nearest", inline: "center" });
}

// ---------- upcoming (curated pro calendar) ----------

async function loadCalendar() {
  try {
    const res = await fetch("data/calendar.json?_=" + Date.now(), { cache: "no-store" });
    state.calendar = res.ok ? await res.json() : { events: [] };
  } catch { state.calendar = { events: [] }; }
  if (state.mode === "upcoming") render();
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (iso) => { const [y, m] = iso.split("-"); return `${MONTHS_LONG[+m - 1]} ${y}`; };
const daysUntil = (iso) => Math.round((new Date(iso + "T00:00:00Z") - new Date(todayYmd() + "T00:00:00Z")) / 86400000);
function fmtRange(s, e) {
  const mon = (m) => MONTHS_LONG[+m - 1].slice(0, 3);
  const [, sm, sd] = s.split("-"), [, em, ed] = (e || s).split("-");
  return sm === em ? `${+sd}–${+ed} ${mon(sm)}` : `${+sd} ${mon(sm)} – ${+ed} ${mon(em)}`;
}

// FIP/pro category from a tournament name (for the badge on the timeline).
function fipCategory(name) {
  const n = (name || "").toUpperCase();
  if (/\bMAJOR\b/.test(n)) return "Major";
  if (/FINALS?\b/.test(n)) return "Finals";
  if (/\bP1\b/.test(n)) return "P1";
  if (/\bP2\b/.test(n)) return "P2";
  if (/GOLD/.test(n)) return "Gold";
  if (/SILVER/.test(n)) return "Silver";
  if (/BRONZE/.test(n)) return "Bronze";
  if (/PROMISE/.test(n)) return "Promises";
  return "FIP";
}

// Current + recent FIP/pro tournaments derived from the live match feed (each with
// a date range from its matches) — folded into the timeline so it shows what's on
// now, not only the curated future calendar.
function liveFipEvents() {
  const byT = new Map();
  for (const m of state.matches || []) {
    if (m.source !== "fip") continue;
    const name = m.tournament && m.tournament.name;
    const d = matchDate(m);
    if (!name || !d) continue;
    let e = byT.get(name);
    if (!e) { e = { name, start: d, end: d, live: false, tour: "FIP" }; byT.set(name, e); }
    if (d < e.start) e.start = d;
    if (d > e.end) e.end = d;
    if (m.status === "live") e.live = true;
  }
  return [...byT.values()].map((e) => ({ ...e, category: fipCategory(e.name) }));
}

function renderUpcoming() {
  if (!state.calendar) { app.innerHTML = `<div class="empty">Loading…</div>`; return; }
  const today = todayYmd();
  const daysAgo = (n) => { const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  // merge the curated calendar with live/recent FIP events. Normalise names with
  // accent-folding ("Málaga" == "MALAGA") so a Premier event present in both dedups.
  // Curated wins on metadata (flag, city); we only adopt the live status flag.
  // Live-only events (FIP Bronze/Silver, not on the Premier calendar) are added.
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  const merged = new Map();
  for (const e of state.calendar.events || []) merged.set(norm(e.name), { ...e });
  for (const e of liveFipEvents()) {
    const k = norm(e.name), ex = merged.get(k);
    if (ex) ex.live = ex.live || e.live;
    else merged.set(k, e);
  }
  const evs = [...merged.values()]
    .filter((e) => (e.end || e.start) >= daysAgo(3))   // recent + current + upcoming
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!evs.length) { app.innerHTML = `<div class="empty"><div class="big">🗓️</div>No upcoming events listed.</div>`; return; }

  const td = today.split("-");
  const todayLabel = `${+td[2]} ${MONTHS_LONG[+td[1] - 1].slice(0, 3)}`;
  let html = `<div class="tl">`, lastMonth = "", nowShown = false;
  for (const e of evs) {
    const end = e.end || e.start;
    const live = e.live || (e.start <= today && end >= today);
    const ended = !live && end < today;
    // "Today" marker sits between finished events and the current/upcoming ones.
    if (!nowShown && end >= today) { nowShown = true; html += `<div class="tl-now"><span></span>Today · ${todayLabel}</div>`; }
    const month = monthLabel(e.start);
    if (month !== lastMonth) { lastMonth = month; html += `<div class="tl-month">${esc(month)}</div>`; }
    const d = daysUntil(e.start);
    const when = live ? "On now" : ended ? "Finished" : d === 0 ? "Today" : d === 1 ? "Tomorrow" : `in ${d} days`;
    const cat = (e.category || "").toLowerCase();
    const meta = [e.city, e.tour].filter(Boolean).map(esc).join(" · ");
    html += `<div class="tl-item${live ? " on" : ""}${ended ? " done" : ""}">
      <div class="tl-dot"></div>
      <div class="tl-card">
        <div class="tl-when"><b>${fmtRange(e.start, e.end)}</b><span class="upc-cat cat-${esc(cat)}">${esc(e.category || "")}</span><span class="tl-ago">${when}</span></div>
        <div class="upc-name">${countryFlag(e.country)} ${esc(e.name)}</div>
        ${meta ? `<div class="upc-meta">${meta}</div>` : ""}
      </div>
    </div>`;
  }
  html += `</div>`;
  const upd = state.calendar.generatedAt ? ` · updated ${state.calendar.generatedAt}` : "";
  html += `<div class="upc-foot">Curated pro-tour calendar${upd}. Dates/venues can change.</div>`;
  app.innerHTML = html;
}

// ---------- archive (historic results) ----------

// WPT (World Padel Tour) is a finals-only historic dataset in its own file
// (data/archive/wpt.json), kept separate from index.json so the padel-db export
// pipeline can't clobber it. Turn each season-tournament into the archive's
// match shape: one row per FINAL (Men/Women), winners as the winning side.
function wptMatches(t) {
  const mk = (names) => ({ name: (names || []).join(" / ") || "TBD", players: (names || []).map((n) => ({ name: n, country: null })) });
  const row = (g, round, winners, losers, sets) => ({
    className: g, round,
    teams: [mk(winners), mk(losers)],
    score: { sets: (sets || []).map((s) => [s[0], s[1]]), winner: 0 },
  });
  const out = [];
  // Per gender: the final (authoritative, from Wikipedia) then the deeper rounds
  // (semis/quarters/…, from news extraction) already sorted business-end-first.
  for (const g of ["Men", "Women"]) {
    const f = t.finals && t.finals[g];
    if (f) out.push(row(g, "Final", f.winners, f.runnersUp, f.sets));
    for (const r of (t.rounds || []).filter((r) => (r.gender || "") === g)) {
      out.push(row(g, r.round, r.winners, r.losers, r.sets));
    }
  }
  return out;
}

// Load wpt.json once and seed archiveData (finals) + _wptIndex (list rows) for
// every WPT tournament. Shared by the archive list and the tournament hub so a
// cold deep-link to /tournament/wpt/… works without a matching t/ file.
let _wptLoaded = false;
async function ensureWpt() {
  if (_wptLoaded) return;
  _wptLoaded = true;
  try {
    const wpt = await fetch("data/archive/wpt.json").then((r) => (r.ok ? r.json() : null));
    if (wpt && Array.isArray(wpt.tournaments)) {
      for (const t of wpt.tournaments) {
        const matches = wptMatches(t);
        if (!matches.length) continue;
        // Historic pro-tour circuits (WPT, PPT) sit under the FIP (international) bucket
        // rather than being their own federation; `tour` distinguishes the eras within it.
        const tour = t.tour || "WPT";
        const row = { key: t.key, name: t.name, federation: "FIP", tour, start: t.start, end: t.start, n: matches.length };
        state.archiveData.set(t.key, { matches, name: t.name, federation: "FIP", tour });
        state.wptIndex.set(t.key, row);
      }
    }
    // end-of-season standings, keyed year -> { Men, Women } (see renderArchive)
    for (const r of wpt?.rankings || []) (state.wptRankings[r.year] ||= {})[r.gender] = r.rows;
  } catch { _wptLoaded = false; } // allow a retry on transient failure
}

async function loadArchive() {
  app.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
  let index;
  try {
    [index] = await Promise.all([
      fetch("data/archive/index.json").then((r) => r.json()),
      ensureWpt(),
    ]);
  } catch {
    app.innerHTML = `<div class="empty"><div class="big">📅</div>Results archive not available.</div>`;
    return;
  }
  // fold the preloaded WPT rows into the browseable list
  for (const row of state.wptIndex.values()) index.tournaments.push(row);
  state.archive = index;
  render();
}

// Circuit within the FIP (international) bucket: the FIP/Premier tour, or the
// historic World Padel Tour. Only meaningful for FIP rows.
const tourOf = (t) => t.tour || (t.federation === "FIP" ? "FIP" : null);
const archYear = (t) => (t.start || "").slice(0, 4);

// Year / federation / tour are INDEPENDENT filters that AND together, so they can be
// picked in any order (year → FIP → WPT, or FIP → WPT → year). `skip` lets a caller
// compute counts for one axis while honouring the others (e.g. per-year counts).
const archMonth = (t) => (t.start || "").slice(5, 7); // "MM" | ""
function archiveFiltered(skip = "") {
  const q = state.query.trim().toLowerCase();
  return state.archive.tournaments.filter((t) => {
    if (skip !== "fed" && state.fed !== "all" && t.federation !== state.fed) return false;
    if (skip !== "tour" && state.archiveTour !== "all" && tourOf(t) !== state.archiveTour) return false;
    if (skip !== "year" && state.archiveYear !== "all" && archYear(t) !== state.archiveYear) return false;
    if (skip !== "month" && state.archiveMonth !== "all" && archMonth(t) !== state.archiveMonth) return false;
    if (q && !t.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

// Rough prestige rank from the tournament name, so a single season can be sorted
// marquee-first (Masters Final → Major/P1 → Master/P2 → Gold → Open → Silver →
// Challenger → Bronze → Promises) instead of purely by date. Deliberately fuzzy —
// it's a browse aid across FIP/Premier/WPT/RankedIn, not an official hierarchy.
function prestige(t) {
  const n = (t.name || "").toLowerCase();
  // International pro (FIP/Premier + WPT) always outranks national circuits, so a
  // Premier Major beats a domestic league's "Final Four". Base separates the two
  // bands; the tier keyword orders within each.
  const base = t.federation === "FIP" ? 1000 : 0;
  const wpt = t.tour === "WPT";
  const tier =
    /master\s*final|premier padel finals|fip finals|season finals|final four|\bfinals\b/.test(n) ? 100 :
    /\bmajor\b/.test(n) ? 92 :
    /\bp1\b/.test(n) ? 88 :
    /\bmaster\b/.test(n) ? 84 :          // WPT Master / FIP-era Master
    /\bp2\b/.test(n) ? 80 :
    /\bgold\b/.test(n) ? 70 :
    /\bopen\b/.test(n) ? (wpt ? 66 : 42) : // a WPT Open outranks a club open
    /\bsilver\b/.test(n) ? 52 :
    /\bchallenger\b/.test(n) ? (wpt ? 48 : 32) :
    /\bbronze\b/.test(n) ? 34 :
    /promis/.test(n) ? 6 : 25;
  return base + tier;
}

// End-of-season WPT standings for one year, as two compact top-10 tables (men /
// women). Consecutive rows sharing a rank are the two players of a ranked PAIR —
// grouped so a pair reads as one line. Data from wpt.json's `rankings`.
function wptStandings(year) {
  const r = state.wptRankings[year];
  if (!r || (!r.Men && !r.Women)) return "";
  const table = (rows, title) => {
    if (!rows || !rows.length) return "";
    const byRank = new Map();
    for (const x of rows) { const k = x.rank; if (!byRank.has(k)) byRank.set(k, { rank: k, points: x.points, names: [] }); byRank.get(k).names.push(x.name); }
    const top = [...byRank.values()].sort((a, b) => a.rank - b.rank).slice(0, 10);
    return `<div class="standtab"><div class="standtab__h">${title}</div>` +
      top.map((e) => `<div class="standrow"><span class="sr-rank">${e.rank}</span>` +
        `<span class="sr-name">${e.names.map(esc).join(" / ")}</span>` +
        `<span class="sr-pts">${e.points != null ? e.points.toLocaleString() : ""}</span></div>`).join("") +
      `</div>`;
  };
  const men = table(r.Men, "Men"), women = table(r.Women, "Women");
  if (!men && !women) return "";
  return `<details class="standings"><summary>🏆 ${esc(year)} end-of-season ranking</summary>` +
    `<div class="standgrid">${men}${women}</div>` +
    `<div class="standnote">Season-end WPT ranking (top 10). Players sharing a rank were a ranked pair.</div></details>`;
}

const MONTHS3 = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function renderArchive() {
  const yearView = state.archiveYear !== "all";
  const list = archiveFiltered();
  // A single season sorts marquee-first (prestige, then latest); browsing across all
  // years stays chronological.
  if (yearView) list.sort((a, b) => prestige(b) - prestige(a) || (b.start || "").localeCompare(a.start || ""));
  const shown = list.slice(0, state.archiveCap);
  const all = state.archive.tournaments;
  const yrs = all.map((t) => +archYear(t)).filter(Boolean);
  const span = yrs.length ? `${Math.min(...yrs)}–${Math.max(...yrs)}` : "";
  const scope = [
    yearView ? state.archiveYear : null,
    state.archiveMonth !== "all" ? MONTHS3[+state.archiveMonth] : null,
    state.fed !== "all" ? (state.fed === "FIP" ? "FIP international" : REGION_LABEL[state.fed] || state.fed) : null,
    state.archiveTour !== "all" ? ({ WPT: "World Padel Tour", PPT: "Padel Pro Tour" }[state.archiveTour] || "FIP / Premier") : null,
  ].filter(Boolean).join(" · ");
  let html =
    `<div class="section-label region">📅 ${list.length} tournament${list.length === 1 ? "" : "s"}` +
    `<span class="count">${scope || `${all.length} in archive · ${span}`}</span></div>`;
  // Month sub-filter within a selected season
  if (yearView) {
    const mc = new Map();
    for (const t of archiveFiltered("month")) { const m = archMonth(t); if (m) mc.set(m, (mc.get(m) || 0) + 1); }
    if (mc.size > 1) {
      const months = [...mc.keys()].sort();
      html += `<div class="monthbar"><span class="mchip ${state.archiveMonth === "all" ? "active" : ""}" data-amonth="all">All</span>` +
        months.map((m) => `<span class="mchip ${state.archiveMonth === m ? "active" : ""}" data-amonth="${m}">${MONTHS3[+m]}<span class="cn">${mc.get(m)}</span></span>`).join("") +
        `</div>`;
    }
  }
  // WPT end-of-season standings, shown when a single WPT season is in view
  if (state.archiveTour === "WPT" && yearView) html += wptStandings(state.archiveYear);
  html += shown.map(archiveRow).join("");
  if (list.length > shown.length)
    html += `<button class="morebtn" data-archmore="1">Show ${list.length - shown.length} more ↓</button>`;
  if (!list.length)
    html = `<div class="empty"><div class="big">📅</div>No tournaments${scope ? ` for <b>${esc(scope)}</b>` : ""}.` +
      `<div style="margin-top:8px;color:var(--faint);font-size:13px">Try another year or clear a filter.</div></div>`;
  app.innerHTML = html;
}

function archiveRow(t) {
  const open = state.openArchive.has(t.key);
  const loaded = state.archiveData.get(t.key);
  return `
    <div class="group ${open ? "open" : ""}" data-arch="${esc(t.key)}">
      <div class="group__head" data-archtoggle="${esc(t.key)}">
        <span class="flag">${FLAGS[t.federation] || ""} ${t.federation}</span>
        <span class="group__title">${t.tour && t.tour !== "FIP" ? `<span class="tourtag ${t.tour === "PPT" ? "ppt" : ""}">${esc(t.tour)}</span>` : ""}<span class="tlink" data-tourney="arch" data-tkey="${esc(t.key)}" data-tname="${esc(t.name)}" data-tfed="${esc(t.federation)}">${esc(t.name)}</span></span>
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

// The profile database covers the Nordic (RankedIn) scene plus linked pros, so
// most pro-tour players resolve to nothing — Albin Olsson is ranked #157 in the
// world and still hit a dead end. The official FIP ranking now carries every
// ranked player (with a padelfip profile URL), so when the profile DB misses we
// fall back to it instead of showing an empty state.
let _fipRankCache = null;
async function fipRankRows() {
  if (_fipRankCache) return _fipRankCache;
  try {
    const d = await (await fetch("data/rankings-fip.json?_=" + Date.now())).json();
    _fipRankCache = (d.lists || []).flatMap((l) => (l.rows || []).map((r) => ({ ...r, cat: l.label })));
  } catch { _fipRankCache = []; }
  return _fipRankCache;
}
const normName = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
async function fipFallback(q) {
  const n = normName(q);
  if (n.length < 3) return [];
  const rows = await fipRankRows();
  return rows.filter((r) => { const x = normName(r.name); return x.includes(n) || n.includes(x); }).slice(0, 12);
}

async function searchPlayers(q) {
  state.query = (q || "").trim(); // the empty state names the player searched for
  if ((q || "").trim().length < 2) { state.playerResults = null; state.fipResults = []; render(); return; }
  try {
    const d = await (await fetch("/api/search?q=" + encodeURIComponent(q.trim()))).json();
    state.playerResults = d.players || [];
    state.fipResults = state.playerResults.length ? [] : await fipFallback(q.trim());
  } catch {
    // Profile API unreachable — still try the ranking, so a search degrades to
    // "here they are in the world ranking" instead of "no such player".
    state.playerResults = [];
    state.fipResults = await fipFallback(q.trim());
  }
  render();
}

// Click a player's name in any match row → jump to their profile. Match data carries
// no player id, so resolve the name via search: open the profile directly on a unique
// exact match, otherwise show the search results for disambiguation. Names not in the
// DB (e.g. some 2010s WPT-only players) just yield an empty list — no error.
async function openPlayerByName(name) {
  // Match rows carry the draw marker ("(1)", "(WC)") on the name; it belongs to the
  // entry, not the person, and /api/search finds nothing with it attached.
  const q = String(name || "").replace(DRAW_MARKER, "").trim();
  if (!q) return;
  activateMode("players");
  const el = document.getElementById("q");
  if (el) el.value = q;
  state.query = q;
  render(); // shows the search box populated while the lookup runs
  try {
    const players = (await (await fetch("/api/search?q=" + encodeURIComponent(q))).json()).players || [];
    const exact = players.filter((p) => (p.name || "").toLowerCase() === q.toLowerCase());
    if (exact.length === 1) return openPlayer(exact[0].id);
    if (players.length === 1) return openPlayer(players[0].id);
    state.playerResults = players;
    state.fipResults = players.length ? [] : await fipFallback(q);
    render();
  } catch { state.playerResults = []; state.fipResults = []; render(); }
}

async function openPlayer(id) {
  state.h2h = null; state.comparing = false; state.player = "loading"; state.playerId = id;
  state.profileTours = new Set(); // reset the per-player tournament filter
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
  if (state.playerResults == null) return renderPlayersBrowse();
  if (!state.playerResults.length)
    html = (state.fipResults || []).length
      ? fipFallbackHtml()
      : `<div class="empty"><div class="big">👤</div>${state.query ? `No profile yet for <b>${esc(state.query)}</b>.` : "No players found."}<div style="margin-top:8px;color:var(--faint);font-size:13px;line-height:1.5">Player profiles currently cover the Nordic (RankedIn) scene and linked pros. Many international / pro-tour players aren't in the profile database yet.</div></div>`;
  else html = state.playerResults.map(playerResultRow).join("");
  app.innerHTML = html;
}

// Ranked but not in the profile DB: show what we DO have (world rank, points,
// weekly movement) plus a link to the player's padelfip.com page, and let them
// be followed. Deliberately not styled as a profile — it is a real ranking row,
// not a thin pretend-profile.
function fipRankRow(r) {
  return `
    <div class="fipres">
      <span class="flag">${esc((r.country || "").toUpperCase())}</span>
      <span class="nm">${esc(r.full || r.name)}</span>
      <span class="meta">${esc(r.cat || "")} · #${r.rank}${r.points != null ? ` · ${Math.round(r.points).toLocaleString()} pts` : ""}</span>
      ${star("players", r.id, r.name, r.country || "")}
      ${fipProfileUrl(r) ? `<a class="fiplink" href="${esc(fipProfileUrl(r))}" target="_blank" rel="noopener" title="View on padelfip.com">↗</a>` : ""}
    </div>`;
}

function fipFallbackHtml() {
  const rows = state.fipResults.map(fipRankRow).join("");
  return `<div class="fipfall"><div class="fipfall__lbl">Not in the profile database yet — found in the FIP world ranking</div>${rows}</div>`;
}

// ---------- players: the default view (nothing searched yet) ----------
// /players used to open on a bare "search a player" prompt: nothing to look at,
// and it is the page search engines land people on. Default to something
// browsable instead — who you follow, who is on court today, and the top of the
// world + Danish lists. It all comes from data the app already holds
// (matches.json + the ranking files), so the default view costs no extra call.
function renderPlayersBrowse() {
  ensureRankings(); // the ranking blocks fill in when those files land
  let html = `<div class="browse-hint">Search a player by name above — or start here.</div>`;

  const favs = Object.entries(state.favs.players);
  if (favs.length) {
    html += `<div class="section-label">⭐ Following · ${favs.length}</div>`;
    html += favs.slice(0, 10).map(([id, d]) => favPlayerRow(id, d)).join("");
  }

  html += browseOnCourt();
  html += browseRankBlock("FIP", `${FLAGS.FIP} World ranking`);
  html += browseRankBlock("DK", `${FLAGS.DK} Denmark`);
  html += `<button class="browse-all" data-goto-mode="rankings">All rankings →</button>`;
  app.innerHTML = html;
}

// Names on court today, from the live feed. Matches carry no player id, so these
// are name chips that resolve through search on click (openPlayerByName).
function browseOnCourt() {
  const today = todayYmd();
  const seen = new Map();
  for (const m of state.matches || []) {
    if (m.status === "final") continue;
    const d = matchDate(m);
    if (d && d !== today) continue;
    for (const t of m.teams || []) {
      const ps = (t.players || []).length
        ? t.players
        : (t.name || "").split("/").map((n) => ({ name: n.trim(), country: "" }));
      for (const p of ps) {
        // Drop the draw marker ("(WC)", "(3)", "(Q)"): it belongs to the entry, not
        // the person, and it would otherwise both split one player into several
        // chips and break the name lookup a click runs.
        const name = (p.name || "").replace(DRAW_MARKER, "").trim();
        if (!name || name === "TBD") continue;
        const cur = seen.get(name);
        if (cur) { cur.live = cur.live || m.status === "live"; continue; }
        seen.set(name, { name, country: p.country || "", live: m.status === "live" });
      }
    }
  }
  const rows = [...seen.values()].sort((a, b) => (b.live - a.live) || a.name.localeCompare(b.name));
  if (!rows.length) return "";
  const nLive = rows.filter((r) => r.live).length;
  const shown = rows.slice(0, 40);
  return `<div class="section-label${nLive ? " live" : ""}">${nLive ? '<span class="lampe"></span>' : "🎾 "}On court today · ${rows.length}</div>
    <div class="tplayers">${shown.map((r) => `<span class="pchip pn${r.live ? " onlive" : ""}" data-pname="${esc(r.name)}" title="View ${esc(r.name)}">${countryFlag(r.country)} ${esc(r.name)}</span>`).join("")}${
      rows.length > shown.length ? `<span class="pchip">+${rows.length - shown.length} more</span>` : ""}</div>`;
}

// Top of one federation's lists (men + women), five rows each. FIP world rows
// carry no RankedIn id, so they render as ranking rows (not fake profiles);
// national rows do carry one and open the profile.
function browseRankBlock(fed, label) {
  if (!state.rankings) return "";
  let html = "";
  for (const l of state.rankings.lists.filter((x) => x.fed === fed)) {
    const rows = (l.rows || []).slice(0, 5);
    if (!rows.length) continue;
    html += `<div class="section-label">${label} · ${esc(l.label || l.category || "")}</div>`;
    html += rows.map((r) => (fed === "FIP" ? fipRankRow({ ...r, cat: l.label }) : natRankRow(r))).join("");
  }
  return html;
}

function natRankRow(r) {
  const linked = !!r.id;
  return `<div class="presult${linked ? "" : " noprofile"}"${linked ? ` data-player="${esc(r.id)}"` : ""}>
    <span class="rk">#${r.rank}</span>
    <span class="nm">${countryFlag(r.country)} ${esc(r.name)}</span>
    <span class="meta">${r.points != null ? Math.round(r.points).toLocaleString() + " pts" : ""}</span>
    ${star("players", r.id, r.name, r.country || "")}
  </div>`;
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
  if (state.mode === "players" && state.player !== "loading") render(); // profile ranking + the browse blocks
}

// Every ranking list this player appears in, best rank first.
// National (RankedIn) lists carry a real player id, so those match on id. The FIP
// world list does NOT: only ~27 of its 6,300 rows resolve to a RankedIn id via
// fip_player_links, so matching on id alone hid the world ranking from virtually
// every pro. Both sides use FIP's abbreviated form ("P. Garcia Rodrigo"), so fall
// back to an exact accent-insensitive name match — and only when it is UNIQUE in
// that list, because ~37 abbreviated names are shared by two players and a wrong
// world ranking on a profile is worse than none.
function playerRankings(id, name, country) {
  if (!state.rankings) return [];
  const n = normName(name);
  const cc = (country || "").toUpperCase();
  const out = [];
  for (const l of state.rankings.lists) {
    let row = id ? (l.rows || []).find((r) => r.id === id) : null;
    if (!row && n.length >= 4) {
      const hits = (l.rows || []).filter((r) => normName(r.name) === n);
      if (hits.length === 1) row = hits[0];
      else if (!hits.length && cc) {
        // Compound Spanish surnames are frequently fuller in match data than in
        // the ranking — padel.db has "P. Garcia Rodrigo", FIP publishes
        // "P. Garcia". Accept the ranking name as a PREFIX of ours, but only
        // when the country agrees and exactly one row qualifies; two same-
        // country "P. Garcia"s are genuinely ambiguous and get nothing.
        const pre = (l.rows || []).filter(
          (r) => (r.country || "").toUpperCase() === cc &&
                 normName(r.name).length >= 6 && n.startsWith(normName(r.name))
        );
        if (pre.length === 1) row = pre[0];
      }
    }
    if (row) out.push({ fed: l.fed, movement: !!l.movement, ...row });
  }
  return out.sort((a, b) => a.rank - b.rank);
}
// "P. Garcia Rodrigo" + "Pablo Garcia" -> "Pablo Garcia Rodrigo".
// Only fires on a genuine "X. Surname" abbreviation; anything else is returned
// untouched so a name that is already full never gets a first name bolted on.
function fullNameFor(name, full) {
  const m = /^\s*[^\s.]\.\s+(.+)$/.exec(name || "");
  const first = (full || "").trim().split(/\s+/)[0];
  if (!m || !first) return full && !m ? name : (full || name);
  return `${first} ${m[1]}`;
}

const fipProfileUrl = (r) => (r && r.slug ? "https://www.padelfip.com/player/" + r.slug + "/" : null);

// Age is derived at render time, never stored: a cached "24" goes wrong on a birthday.
function ageFrom(iso) {
  const d = iso ? new Date(iso + "T00:00:00Z") : null;
  if (!d || isNaN(d)) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const before = now.getUTCMonth() < d.getUTCMonth() ||
                 (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
  if (before) age--;
  return age >= 5 && age <= 99 ? age : null;
}

// Profile bio strip. `position` is the COURT SIDE FIP publishes, not handedness —
// FIP does not publish dominant hand, so do not label it as one.
function bioRow(bio) {
  if (!bio) return "";
  const bits = [];
  const age = ageFrom(bio.birth_date);
  if (age != null) {
    const [y, m, d] = bio.birth_date.split("-");
    bits.push(`<span class="pb" title="Born ${d}/${m}/${y}"><b>${age}</b> yrs</span>`);
  }
  if (bio.height_cm) bits.push(`<span class="pb"><b>${(bio.height_cm / 100).toFixed(2)}</b> m</span>`);
  if (bio.position) bits.push(`<span class="pb"><b>${esc(bio.position)}</b> side</span>`);
  // FIP writes "--" for facts it doesn't have. The exporter strips those, but a chip
  // reading "--" is the kind of thing that reaches production once and stays, so the
  // renderer refuses dash-only values too. Tested by shape: "Мурманск" is a real place.
  const place = (bio.birth_place || "").trim();
  if (place && !/^[\s\-‐-―.,/]*$/.test(place)) bits.push(`<span class="pb pb-place">${esc(place)}</span>`);
  if (!bits.length) return "";
  const src = fipProfileUrl(bio.fip_slug ? { slug: bio.fip_slug } : null);
  return `<div class="pbio">${bits.join("")}` +
    (src ? `<a class="pbio-src" href="${src}" target="_blank" rel="noopener">FIP profile ↗</a>` : "") +
    `</div>`;
}

// Elo rating + the rank it implies. The rank matters as much as the number: a
// bare "2053" means nothing on its own, and the pool it is ranked WITHIN is the
// only context in which it means anything at all. Men and women are rated
// separately, as are the RankedIn and FIP tours, so the tooltip always names
// the population rather than implying a single global ladder.
// Absent when the player has too few matches to rate, or before the table is
// loaded — the API returns null and this renders nothing.
const ELO_POOL = { M: "men", W: "women" };
const ELO_SOURCE = { fip: "FIP", rin: "Nordic" };
function eloStat(elo) {
  if (!elo || elo.rating == null) return "";
  const pool = ELO_POOL[elo.pool] || "";
  const src = ELO_SOURCE[elo.source] || "";
  const title = `Elo ${elo.rating} — #${elo.rank} of ${elo.of} rated ${src} ${pool}`
    + ` · ${elo.n_matches} matches`
    + (elo.peak ? ` · peak ${elo.peak}${elo.peak_date ? " " + elo.peak_date.slice(0, 7) : ""}` : "");
  return `<div class="pstat hi" title="${esc(title)}"><b>${esc(elo.rating)}</b>`
    + `<span>Elo #${esc(elo.rank)}</span></div>`;
}

function renderProfile() {
  if (state.player === "loading") { app.innerHTML = `<div class="skel"></div><div class="skel"></div>`; return; }
  const { player, summary, matches } = state.player;
  const pct = summary.total ? Math.round((summary.wins / summary.total) * 100) : 0;
  const ranks = playerRankings(player.id, player.name, player.country);
  // Every other source only has FIP's abbreviated form ("T. Zapata"); the world
  // ranking feed carries the real first name, so expand it for the HEADING ONLY.
  // player.name still drives the follow key, search and head-to-head - swapping
  // the underlying value would orphan follows saved under the short name.
  //
  // Take the FIRST NAME from the ranking and keep OUR surname: FIP's surname is
  // sometimes the shorter one ("P. Garcia Rodrigo" here vs "Pablo Garcia" there),
  // so using its `full` wholesale would drop a surname rather than add a name.
  const shownName = fullNameFor(player.name, (ranks.find((r) => r.fed === "FIP") || {}).full);
  let html = `<button class="pback" data-pback="1">← Search</button>
    <div class="phead">
      <span class="flag">${esc((player.country || "").toUpperCase())}</span>
      <h2>${esc(shownName)}</h2>
      ${star("players", player.id, player.name, player.country || "")}
      <div class="pstats">
        <div class="pstat"><b>${summary.total}</b><span>matches</span></div>
        <div class="pstat"><b>${summary.wins}-${summary.losses}</b><span>W-L</span></div>
        <div class="pstat"><b>${pct}%</b><span>win rate</span></div>
        ${summary.titles ? `<div class="pstat hi"><b>${summary.titles}</b><span>title${summary.titles === 1 ? "" : "s"}</span></div>` : ""}
        ${summary.finals ? `<div class="pstat"><b>${summary.finals}</b><span>finals</span></div>` : ""}
        ${summary.sets && summary.sets.pct != null ? `<div class="pstat"><b>${summary.sets.pct}%</b><span>sets won</span></div>` : ""}
        ${summary.games && summary.games.pct != null ? `<div class="pstat"><b>${summary.games.pct}%</b><span>games won</span></div>` : ""}
        ${eloStat(state.player.elo)}
      </div>
    </div>`;
  html += bioRow(state.player.bio);
  const form = summary.form || [];
  if (form.length)
    html += `<div class="form-row"><span class="form-lbl">Form</span>${form.map((r) => `<span class="fchip ${r === "W" ? "w" : "l"}">${r}</span>`).join("")}${summary.streak > 1 ? `<span class="streak">${summary.streak} ${summary.streakType === "W" ? "wins" : "losses"} in a row</span>` : ""}</div>`;
  const tp = state.player.topPartner;
  if (tp)
    html += `<div class="toppartner" data-player="${esc(tp.id)}"><span class="tp-lbl">Top partner</span><b>${esc(tp.name)}</b><span class="tp-meta">${tp.matches} matches · ${tp.wins}-${tp.matches - tp.wins}</span></div>`;
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
  if (summary.byYear.length)
    html += `<div class="section-label">By year</div><div class="years">` +
      summary.byYear.map((y) => `<span class="ychip"><b>${esc(y.yr)}</b> ${y.won}<span class="ysep">/</span>${y.played}</span>`).join("") +
      `</div>`;

  // Tournament filter over the loaded matches. Multi-select: with none selected all
  // matches show; clicking tournament chips narrows to just those (any-of).
  const tourCounts = new Map();
  for (const m of matches) { const t = m.tournament || "—"; tourCounts.set(t, (tourCounts.get(t) || 0) + 1); }
  const sel = state.profileTours;
  const shown = sel.size ? matches.filter((m) => sel.has(m.tournament || "—")) : matches;
  if (tourCounts.size > 1) {
    const tours = [...tourCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    html += `<div class="section-label">Filter by tournament</div><div class="chips profchips">` +
      `<span class="chip ${sel.size === 0 ? "active" : ""}" data-ptour="__all">All</span>` +
      tours.map(([t, n]) => `<span class="chip ${sel.has(t) ? "active" : ""}" data-ptour="${esc(t)}" title="${esc(t)}">${esc(t)}<span class="cn">${n}</span></span>`).join("") +
      `</div>`;
  }
  const label = sel.size ? `Matches · ${shown.length} of ${matches.length}` : `Recent matches (${matches.length})`;
  html += `<div class="section-label">${label}</div>` +
    (shown.length ? shown.map((m) => apiMatchRow(m)).join("") : `<div class="empty" style="padding:24px">No matches for the selected tournament${sel.size === 1 ? "" : "s"}.</div>`);
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

// One match in a player profile / head-to-head list. The tournament name can be very
// long ("Swedish Padel Tour- SPT 2, 360 Björkquist Måleri, Karlstad, samt övriga…"),
// so it gets its OWN full-width line below the row instead of sharing the right-hand
// column — otherwise it blew the auto-width column out and squeezed the team names to
// zero width (they looked blank). Score + date stay right-aligned, one per line.
function apiMatchRow(m) {
  const t = m.teams;
  const line = (s) => `<div class="team ${t[s].won ? "win" : ""}"><span class="nm">${esc(t[s].name)}</span></div>`;
  const meta = [m.tournament, m.round].filter(Boolean).join(" · ");
  return `<div class="match"><div class="match__main archm pmatch">
    <div class="teams">${line(0)}${line(1)}</div>
    <div class="side">
      <span class="score-str">${esc(m.score || "")}</span>
      ${m.date ? `<span class="pdate">${esc(m.date)}</span>` : ""}
    </div>
  </div>${meta ? `<div class="pmeta" title="${esc(meta)}">${esc(meta)}</div>` : ""}</div>`;
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
    // WPT lives in its own file, not t/<key>.json — ensure it's loaded, then serve
    // from archiveData (covers cold deep-links to /tournament/wpt/…).
    if (key.startsWith("wpt-") && !state.archiveData.has(key)) {
      render(); // skeleton
      ensureWpt().then(() => {
        const d = state.archiveData.get(key) || { matches: [] };
        if (state.tournament && state.tournament.key === key) {
          state.tournament.matches = d.matches;
          if (d.name) state.tournament.name = d.name;
          state.tournament.fed = "FIP";
          state.tournament.tour = "WPT";
        }
        render(); setTitle();
      });
      return;
    }
    if (state.archiveData.has(key)) {
      const d = state.archiveData.get(key);
      state.tournament.matches = d.matches;
      if (d.tour) state.tournament.tour = d.tour;   // keep the WPT marker on the hub
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
// `project` = fill forward with "TBD · winner advances" stubs (useful for a LIVE
// draw to show who plays next). Off for historic/archive events, where the rounds
// we have are all that were played — projecting empties just adds BYE/TBD noise.
function buildBracket(matches, project = true) {
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
  if (project) for (const n of nodes.filter((n) => n.m && n.round < lastRi && !pointed.has(n))) {
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
    <div class="trow1"><span class="flag">${FLAGS[tv.fed] || ""} ${esc(tv.fed || "")}</span>${tv.tour && tv.tour !== "FIP" ? `<span class="tourtag ${tv.tour === "PPT" ? "ppt" : ""}">${esc(tv.tour)}</span>` : ""}${star("tournaments", tv.key, tv.name, tv.fed)}</div>
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
      // WPT rounds are news-sourced and partial, so a bracket would be full of gap
      // "BYE" slots — show a clean round-grouped list instead. Complete draws
      // (FIP/RankedIn archive, or a live event) still get the visual bracket.
      const bracket = tv.tour === "WPT" ? null : buildBracket([...rmap.values()].flat(), tv.kind === "live");
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

// ---------- world No.1 timeline ----------
// The deepest history the archive holds: FIP records a year-end No.1 pair back to 1986,
// where tournament data starts in 2006 and round-level detail in 2010. Consecutive years
// held by the same pair are collapsed into one era — the shape of the sport's history is
// who stayed on top and for how long, which a flat year-by-year list buries.
async function loadNo1() {
  try {
    const r = await fetch("data/archive/world-no1.json");
    state.no1 = await r.json();
  } catch { state.no1 = { years: [], error: true }; }
  render();
}

function renderNo1() {
  if (!state.no1) return;
  const cat = state.no1Cat || "Men";
  const q = state.query.trim().toLowerCase();
  const years = (state.no1.years || []).filter((y) => y[cat]);

  // group consecutive years that share the same pair
  const eras = [];
  for (const y of years) {
    const key = y[cat].map((p) => p.name).join(" & ");
    const prev = eras[eras.length - 1];
    if (prev && prev.key === key && prev.from - y.year === 1) { prev.from = y.year; prev.rows.push(y); }
    else eras.push({ key, from: y.year, to: y.year, players: y[cat], rows: [y] });
  }
  const shown = q ? eras.filter((e) => e.key.toLowerCase().includes(q)) : eras;

  const counts = { Men: (state.no1.years || []).filter((y) => y.Men).length,
                   Women: (state.no1.years || []).filter((y) => y.Women).length };
  const span = years.length ? `${years[years.length - 1].year}–${years[0].year}` : "";

  let html = `<div class="rank-sel">
    ${["Men", "Women"].map((c) => `<button class="rchip ${cat === c ? "on" : ""}" data-no1cat="${c}">${c} · ${counts[c]}</button>`).join("")}
  </div>`;
  html += `<div class="no1-note">Year-end world No.1 pair, ${esc(span)}. The authority changes with the era — the Argentine APA and Spanish FEP before a global tour existed, then Padel Pro Tour, World Padel Tour and today's FIP ranking — so each era is labelled with its source. FIP records 1986–87 from <em>historical sources</em> rather than a published ranking, and no women's No.1 is recorded before 1990.</div>`;
  html += `<div class="section-label region">👑 ${cat === "Men" ? "Men's" : "Women's"} world No.1<span class="count">${shown.length} era${shown.length === 1 ? "" : "s"} · ${years.length} years</span></div>`;

  html += shown.map((e, i) => {
    const yrs = e.to - e.from + 1;
    const label = yrs === 1 ? String(e.from) : `${e.from}–${String(e.to).slice(2)}`;
    // an era is "current" only if it runs to the most recent year on record
    const cur = i === 0 && e.to === years[0].year;
    const srcs = [...new Set(e.rows.map((r) => r.source).filter(Boolean))];
    return `<div class="no1-era${cur ? " cur" : ""}">
      <div class="no1-yrs"><b>${label}</b><span>${yrs} yr${yrs === 1 ? "" : "s"}</span></div>
      <div class="no1-pair">
        ${e.players.map((p) => `<span class="no1-name">${p.code ? countryFlag(p.code) + " " : ""}${esc(p.name)}</span>`).join('<span class="no1-amp">&amp;</span>')}
        <div class="no1-meta">
          ${cur ? '<span class="no1-reign">current</span>' : ""}
          ${srcs.map((sv) => `<span class="no1-src${/historical/i.test(sv) ? " hist" : ""}">${esc(sv)}</span>`).join("")}
        </div>
      </div>
    </div>`;
  }).join("");

  if (!shown.length) html += `<div class="empty">${q ? "No pair matches." : "No data."}</div>`;
  app.innerHTML = html;
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

// "Race to #1" — the top-5 story for a FIP list: points, gap to the leader, and
// points each is defending (about to expire) in the next ~8 weeks. Reuses the
// `defending` field the FIP export computes from padel.db.
function racePanel(rows, cat) {
  const top = (rows || []).slice(0, 5);
  if (top.length < 2 || !("defending" in top[0])) return "";
  const leader = top[0].points;
  const fmt = (n) => Math.round(n || 0).toLocaleString();
  const body = top.map((r) => {
    const gap = leader - r.points;
    const def = r.defending || 0;
    return `<div class="race-row${r.id ? " has-profile" : ""}"${r.id ? ` data-player="${esc(r.id)}"` : ""}>
      <span class="race-rk${r.rank <= 3 ? " m" + r.rank : ""}">${r.rank}</span>
      <span class="race-nm">${countryFlag(r.country)} ${esc(r.name)}</span>
      <span class="race-pt">${fmt(r.points)}</span>
      <span class="race-gp">${gap === 0 ? "level" : "−" + fmt(gap)}</span>
      <span class="race-df${def >= 2000 ? " hot" : ""}" title="points being defended (at risk of expiring) in the next ~8 weeks">def ${fmt(def)}</span>
    </div>`;
  }).join("");
  return `<div class="race">
    <div class="race-hd">🏁 Race to #1 · ${cat === "women" ? "Women" : "Men"}</div>
    <div class="race-cols"><span></span><span></span><span>pts</span><span>gap</span><span>defending</span></div>
    ${body}
    <div class="race-ft">FIP points expire 52 weeks after they're won · <b>def</b> = points at risk of dropping in the next ~8 weeks.</div>
  </div>`;
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
  // Nationality filter — only meaningful on a multi-country list (i.e. FIP world).
  const natCounts = {};
  for (const r of list?.rows || []) if (r.country) natCounts[r.country] = (natCounts[r.country] || 0) + 1;
  const nats = Object.keys(natCounts).sort();
  const multiCountry = nats.length > 1;
  if (!multiCountry || (state.rankNat && !natCounts[state.rankNat])) state.rankNat = ""; // clear stale selection on list switch
  if (multiCountry) {
    html += `<div class="rank-natf">
      <span class="rank-natf__lbl">Nationality</span>
      <select id="ranknat" class="year">
        <option value="">All nationalities (${nats.length})</option>
        ${nats.map((c) => `<option value="${esc(c)}"${state.rankNat === c ? " selected" : ""}>${countryFlag(c)} ${esc(c.toUpperCase())} · ${natCounts[c]}</option>`).join("")}
      </select>
    </div>`;
  }
  const shown = state.rankNat ? rows.filter((r) => r.country === state.rankNat) : rows;
  if (multiCountry && !state.rankNat && !q) html += racePanel(list?.rows, state.rankCat);
  html += `<div class="section-label region"><span class="rflag">${FLAGS[state.rankFed] || ""}</span>${state.rankFed} ${list?.label || ""} ranking` +
    `<span class="count">${state.rankNat ? `${countryFlag(state.rankNat)} ${shown.length} of ` : ""}${(list?.total ?? rows.length).toLocaleString()} ranked${movement ? " · ▲▼ vs last week" : ""}</span></div>`;
  // Full list caps at 250 rendered rows (keeps the DOM light on a 1000-deep list);
  // a nationality filter renders all matches so every player of that country shows.
  const cap = state.rankNat || q ? 1000 : 250;
  html += `<div class="ranktable${movement ? " hasmove" : ""}">` + shown.slice(0, cap).map((r) => rankRow(r, movement)).join("") + `</div>`;
  if (!shown.length) html += `<div class="empty">No players match.</div>`;
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
  const flag = countryFlag(r.country);
  return `<div class="rankrow${prof}${medal}"${r.id ? ` data-player="${esc(r.id)}"` : ""}>
    <span class="rnum">${r.rank}</span>
    <span class="rmove">${moveCell(r, movement)}</span>
    <span class="nm">${flag ? `<span class="rnat" title="${esc(r.country)}">${flag}</span> ` : ""}${esc(r.name)}</span>
    <span class="rclub">${esc(r.club || "")}</span>
    <span class="rpts">${r.points != null ? Math.round(r.points).toLocaleString() : ""}${r.defending ? `<span class="rdef" title="points being defended (at risk) in the next ~8 weeks">def ${Math.round(r.defending).toLocaleString()}</span>` : ""}</span>
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
  if (c.dataset.tour !== undefined) {            // sub-level: FIP / Premier vs WPT
    state.archiveTour = c.dataset.tour;
  } else {
    state.fed = c.dataset.fed;
    if (state.fed !== "FIP") state.archiveTour = "all"; // the tour level only exists under FIP
  }
  state.archiveCap = 40;
  render();
});

document.getElementById("daystrip").addEventListener("click", (e) => {
  const b = e.target.closest(".dchip");
  if (!b) return;
  if (b.dataset.year !== undefined) {            // archive: year picker
    state.archiveYear = b.dataset.year;
    state.archiveMonth = "all";                  // switching year clears the month sub-filter
    state.archiveCap = 40;
  } else {
    state.day = b.dataset.day;
  }
  render();
});

// archive: month sub-filter (only present when a single year is selected)
app.addEventListener("click", (e) => {
  const m = e.target.closest("[data-amonth]");
  if (!m) return;
  state.archiveMonth = m.dataset.amonth;
  state.archiveCap = 40;
  render();
});

// mode switch: Live / Results / Players / Rankings
function activateMode(mode) {
  state.mode = mode;
  state.fed = "all";
  state.day = mode === "live" ? todayYmd() : "all";   // live feed defaults to today; other modes span all
  state.query = "";
  state.player = null; state.playerId = null; state.h2h = null; state.playerResults = null; state.comparing = false;
  state.tournament = null;
  state.rankCountryQuery = "";
  state.archiveTour = "all";
  state.archiveMonth = "all";
  state.archiveCap = 40;
  document.querySelectorAll("#modes button").forEach((x) => x.classList.toggle("active", x.dataset.mode === mode));
  document.getElementById("tabs").style.display = mode === "live" ? "" : "none";
  document.getElementById("chips").style.display = mode === "live" || mode === "archive" || mode === "events" ? "" : "none";
  const qEl = document.getElementById("q");
  qEl.value = "";
  qEl.closest(".search").style.display = mode === "favorites" || mode === "upcoming" ? "none" : "";
  qEl.placeholder =
    mode === "players" ? "Search a player by name…" :
    mode === "rankings" ? "Filter this ranking…" :
    mode === "events" ? "Search competitions…" :
    mode === "archive" ? "Search tournament…" :
    mode === "no1" ? "Find a No.1 pair…" : "Search player or tournament…";
  if (mode === "no1" && !state.no1) loadNo1();
  else if (mode === "archive" && !state.archive) loadArchive();
  else if (mode === "rankings" && !state.rankings) loadRankings();
  else if (mode === "upcoming" && !state.calendar) loadCalendar();
  else render();
  syncUrl();
}

document.getElementById("modes").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && b.dataset.mode !== state.mode) activateMode(b.dataset.mode);
});

// Brand = home link. It's a real <a href="/"> (crawlable, middle-click / ⌘-click
// opens a new tab, works without JS), but a plain left-click routes in-app instead
// of triggering a full page reload.
document.getElementById("brand").addEventListener("click", (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // let the browser handle it
  e.preventDefault();
  state.tournament = null;
  activateMode("live");
  try { window.scrollTo(0, 0); } catch {}
});

// rankings country filter — narrows the federation chips without re-rendering
// #app (so the input keeps focus). Enter jumps to a lone match.
app.addEventListener("input", (e) => {
  if (e.target.id !== "rankcountry") return;
  state.rankCountryQuery = e.target.value;
  applyCountryFilter();
});
// nationality filter dropdown (rankings) — narrows a ranking to one nationality
app.addEventListener("change", (e) => {
  if (e.target.id !== "ranknat") return;
  state.rankNat = e.target.value;
  render();
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
  const n1 = e.target.closest("[data-no1cat]");
  if (n1) { state.no1Cat = n1.dataset.no1cat; render(); return; }
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

  // profile: tournament filter chips (multi-select; "All" clears)
  const ptc = e.target.closest("[data-ptour]");
  if (ptc) {
    const t = ptc.dataset.ptour;
    if (t === "__all") state.profileTours.clear();
    else if (state.profileTours.has(t)) state.profileTours.delete(t);
    else state.profileTours.add(t);
    render();
    return;
  }

  const gm = e.target.closest("[data-goto-mode]");
  if (gm) { activateMode(gm.dataset.gotoMode); return; }

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
  // player name → profile (checked before data-open so clicking a name in a match
  // row doesn't also toggle the row's detail).
  const pn = e.target.closest("[data-pname]");
  if (pn) { openPlayerByName(pn.dataset.pname); return; }
  const om = e.target.closest("[data-open]");
  if (om) {
    const id = om.dataset.open;
    if (state.openMatches.has(id)) state.openMatches.delete(id);
    else {
      state.openMatches.add(id);
      const m = state.matches.find((x) => x.id === id);
      if (m) loadMatchup(m); // renders on its own when the lookup lands
    }
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
  if (state.mode === "no1") return "/world-no1";
  if (state.mode === "events") return "/events";
  if (state.mode === "upcoming") return "/upcoming";
  return "/";
}

function setTitle() {
  const P = state.player && state.player !== "loading" ? state.player.player : null;
  let t = "PadelTicker — live padel scores";
  if (state.tournament) t = `${state.tournament.name} — draw, results & schedule · PadelTicker`;
  else if (P) t = `${P.name} — padel results, ranking & head-to-head · PadelTicker`;
  else if (state.mode === "rankings" && state.rankFed) t = `${state.rankFed === "FIP" ? "FIP world" : REGION_LABEL[state.rankFed] || state.rankFed} padel ranking${state.rankCat === "women" ? " — women" : ""} · PadelTicker`;
  else if (state.mode === "archive") t = "Padel results & tournament archive · PadelTicker";
  else if (state.mode === "no1") t = "World No.1 padel players since 1986 · PadelTicker";
  else if (state.mode === "players") t = "Padel players — profiles, results & head-to-head · PadelTicker";
  else if (state.mode === "favorites") t = "Following — your padel players & tournaments · PadelTicker";
  else if (state.mode === "events") t = "Padel tournaments & leagues — live competitions · PadelTicker";
  else if (state.mode === "upcoming") t = "Upcoming padel tournaments — Premier Padel calendar · PadelTicker";
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
    else if (seg[0] === "world-no1") activateMode("no1");
    else if (seg[0] === "upcoming") activateMode("upcoming");
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
// world ranks for the match rows - deferred so it never delays first paint
setTimeout(loadRanksLite, 600);
