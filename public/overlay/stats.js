// Changeover stats overlay — the runtime.
//
// An OBS Browser Source that watches one FIP match through /api/live-detail and,
// during side changes only, brings up a stats card about the match in progress.
// It renders nothing the rest of the time: a blank page is the resting state.
//
//   /overlay/stats.html?tid=397&day=29&court=Centralni&delay=30
//   /overlay/stats.html?event=FIP-2026-3507&player=stupaczuk&sampled=1
//
// Design constraints that shaped this file (see STATS-OVERLAY.md):
//   * NO writes anywhere. All accumulation is in page memory, mirrored to
//     localStorage so an OBS source reload does not reset the match.
//   * The main refresh daemon runs at ~1 min and a changeover is ~60-90 s, so
//     this polls its own fast path rather than reading data/matches.json.
//   * `delay` exists because a relayed HLS stream is 20-40 s behind the court.
//     An undelayed card fires before viewers have seen the game that caused it.
//   * A card must never still be up when play resumes — every window is bounded
//     by the real length of the break, and a card that cannot fit is skipped.

import {
  createState, loadState, saveState, ingest, fromSporteaser,
  TRIGGER, WINDOW,
} from "./accumulator.js";

// ---------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------

const P = new URLSearchParams(location.search);
const num = (k, d) => (P.has(k) && Number.isFinite(+P.get(k)) ? +P.get(k) : d);
const CFG = {
  tid: P.get("tid"),
  day: P.get("day"),
  event: P.get("event"),
  match: P.get("match"),                 // sporteaser match id — the exact way
  court: (P.get("court") || "").toLowerCase(),
  player: (P.get("player") || "").toLowerCase(),
  delay: Math.max(0, num("delay", 0)),   // seconds of stream delay to hold cards by
  sampled: P.get("sampled") === "1",
  theme: P.get("theme") === "light" ? "light" : "dark",
  pos: P.get("pos") || "bottom-left",
  scale: num("scale", 1),
  poll: Math.max(1500, num("poll", 3000)),
  show: num("show", 50),                 // total seconds of card time per changeover
  debug: P.get("debug") === "1",
  preview: P.get("preview"),             // pin one card on screen, for positioning
  api: P.get("api") || "",               // point at a deployed origin while testing locally
};

// Assigned in boot(). They stay null when this module is imported outside a
// browser — test/render.js loads it against a synthetic DOM to exercise the card
// builders without a dev server, and must not trip over the page bootstrap.
let stage = null;
let dbg = null;

// A card must be off screen before the next point. Leave a margin at the end of
// every break so a slow fade never overlaps the resumption of play.
const SAFETY = 6;

const log = [];
function say(msg, isErr) {
  log.unshift(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  log.length = Math.min(log.length, 14);
  if (CFG.debug && dbg) dbg.innerHTML = log.map((l, i) => (i ? l : `<b>${l}</b>`)).join("\n");
  if (isErr) console.warn("[overlay]", msg);
}

// ---------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------

const relay = (qs) => `${CFG.api}/api/live-detail?${qs}`;

async function pollSporteaser() {
  const qs = new URLSearchParams({ tid: CFG.tid, day: CFG.day });
  // Ask for one match when we know which: a full day is ~500 KB and the overlay
  // follows exactly one of them.
  if (CFG.match) qs.set("match", CFG.match);
  const res = await fetch(relay(qs.toString()), { cache: "no-store" });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const body = await res.json();
  const matches = body.matches || [];
  const m = CFG.match ? matches[0] : pickSporteaser(matches);
  if (!m) return null;
  return fromSporteaser(m, Date.now());
}

/** Choose the followed match out of a day: by court, else by player, else the one on court. */
function pickSporteaser(matches) {
  const live = matches.filter((m) => m.matchStatus === 2);
  const pool = live.length ? live : matches;
  if (CFG.court) {
    const hit = pool.find((m) => String(m.fieldName || "").toLowerCase().includes(CFG.court));
    if (hit) return hit;
  }
  if (CFG.player) {
    const hit = pool.find((m) =>
      `${m.homeTeam?.name || ""} ${m.awayTeam?.name || ""}`.toLowerCase().includes(CFG.player));
    if (hit) return hit;
  }
  // No selector and more than one match on court is ambiguous — following the
  // wrong match silently is worse than showing nothing.
  return pool.length === 1 ? pool[0] : (CFG.court || CFG.player ? null : pool[0] || null);
}

// Crionet's live board is server-rendered HTML. The edge has no DOM, so the relay
// passes the markup through and it is parsed here with the browser's own
// DOMParser. Selectors mirror parseLiveBoard() in src/adapters/fip.js — that is
// the reference implementation; this reads the extra td.set cells it does not need.
export function parseCrionetBoards(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const boards = [];
  for (const table of doc.querySelectorAll("table")) {
    if (!table.querySelector("tr.scorebox-header-live")) continue;
    const rows = [...table.querySelectorAll("tr")].filter((tr) => tr.querySelector("td.team"));
    if (rows.length < 2) continue;
    const teams = rows.slice(0, 2).map((tr) => ({
      players: [...tr.querySelectorAll(".double .line-thin")].map((e) => clean(e.textContent)).filter(Boolean),
      points: clean(tr.querySelector("td.points")?.textContent) || null,
      serving: !!tr.querySelector("img.ballg"),
      sets: [...tr.querySelectorAll("td.set")].map((td) => parseInt(clean(td.textContent), 10)).filter(Number.isFinite),
    }));
    boards.push({ teams, warmup: /warm\s*up/i.test(clean(table.querySelector(".live-status-summary")?.textContent)) });
  }
  // Zero boards is the normal resting state: the live board only ever lists
  // matches on court, and it is ALSO permanently empty for a Sporteaser-scored
  // event. Never an error.
  return boards;
}

async function pollCrionet() {
  const res = await fetch(relay(new URLSearchParams({ event: CFG.event }).toString()), { cache: "no-store" });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const boards = parseCrionetBoards(await res.text());
  const b = CFG.player
    ? boards.find((x) => x.teams.some((t) => t.players.join(" ").toLowerCase().includes(CFG.player)))
    : boards.length === 1 ? boards[0] : null;
  if (!b) return null;

  const [ta, tb] = b.teams;
  const n = Math.max(ta.sets.length, tb.sets.length);
  const sets = [];
  for (let i = 0; i < n; i++) sets.push([ta.sets[i] ?? 0, tb.sets[i] ?? 0]);
  return {
    at: Date.now(),
    matchId: `crionet:${[...ta.players, ...tb.players].join("+").toLowerCase().replace(/[^a-z+]/g, "")}`,
    status: "live",
    court: null,
    round: null,
    teams: [
      { name: ta.players.join(" / "), players: ta.players.map((name) => ({ name, country: null })) },
      { name: tb.players.join(" / "), players: tb.players.map((name) => ({ name, country: null })) },
    ],
    sets,
    points: b.warmup ? null : ta.points != null || tb.points != null ? [ta.points ?? "", tb.points ?? ""] : null,
    serving: ta.serving ? 0 : tb.serving ? 1 : null,
    log: null,                 // Crionet publishes no point log — sampled tier only
    setDurations: null,
  };
}

// ---------------------------------------------------------------------------
// context tier — fetched once per match, then cached for its lifetime
// ---------------------------------------------------------------------------

// A live-feed name does not always resolve to a profile in the history DB. When
// it does not, the context card is dropped silently rather than showing a blank
// or a zero — an empty stat on air reads as "these two have never met", which is
// a claim we cannot make.
export const ctx = { state: "idle", data: null };

const SURNAME_PARTICLES = new Set(["de", "del", "della", "di", "van", "der", "den", "la", "le", "dos", "da"]);
function surname(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  return prev && SURNAME_PARTICLES.has(prev.toLowerCase()) ? `${prev} ${last}` : last;
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");

async function resolvePlayer(fullName) {
  const q = surname(fullName);
  if (q.length < 3) return null;
  try {
    const res = await fetch(`${CFG.api}/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return null;
    const { players } = await res.json();
    if (!players?.length) return null;
    // Score on how much of the live-feed name the candidate actually contains —
    // a bare surname match on a common name is not good enough to put on air.
    const want = norm(fullName);
    let best = null;
    for (const p of players) {
      const got = norm(p.name);
      const tokens = String(fullName).split(/\s+/).map(norm).filter((t) => t.length > 2);
      const hits = tokens.filter((t) => got.includes(t)).length;
      const score = hits + (got === want ? 3 : 0) + (got.includes(norm(q)) ? 1 : 0);
      if (hits >= 2 && (!best || score > best.score)) best = { p, score };
    }
    return best?.p || null;
  } catch { return null; }
}

async function loadContext(obs) {
  if (ctx.state !== "idle" || !obs?.teams) return;
  ctx.state = "loading";
  try {
    const names = [obs.teams[0].players.map((p) => p.name), obs.teams[1].players.map((p) => p.name)];
    const ids = await Promise.all(names.map((side) => Promise.all(side.map(resolvePlayer))));
    const A = ids[0].filter(Boolean), B = ids[1].filter(Boolean);
    if (!A.length || !B.length) { ctx.state = "none"; say(`context: names did not resolve (${A.length}+${B.length})`); return; }

    const qs = new URLSearchParams();
    A.forEach((p, i) => qs.set(`a${i + 1}`, p.id));
    B.forEach((p, i) => qs.set(`b${i + 1}`, p.id));
    const res = await fetch(`${CFG.api}/api/matchup?${qs}`);
    const matchup = res.ok ? await res.json() : null;

    // Elo is only comparable inside its own (source, pool) — men and women, and
    // the FIP and RankedIn tours, are rated separately. Ratings from different
    // pools are never shown against each other.
    const elo = {};
    await Promise.all([...A, ...B].map(async (p) => {
      try {
        const r = await fetch(`${CFG.api}/api/player/${encodeURIComponent(p.id)}`);
        if (!r.ok) return;
        const j = await r.json();
        if (j?.elo?.rating) elo[p.id] = j.elo;
      } catch { /* no rating for this player */ }
    }));

    ctx.data = { A, B, matchup, elo };
    ctx.state = "ready";
    say(`context: ${A.length}v${B.length} resolved, h2h ${matchup?.pair?.n ?? 0} meeting(s)`);
  } catch (err) {
    ctx.state = "none";
    say(`context failed: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// cards
// ---------------------------------------------------------------------------

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const teamLabel = (t) => (t?.players || []).map((p) => surname(p.name)).join(" / ") || t?.name || "—";
const pct = (w, n) => (n ? `${Math.round((w / n) * 100)}%` : "—");
const mins = (sec) => (sec == null ? "—" : sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : `${sec}s`);

/** Rows are [label, valueA, valueB, subA, subB]; the higher value is tinted. */
function statRow(label, a, b, subA, subB) {
  const na = parseFloat(String(a)), nb = parseFloat(String(b));
  const lead = Number.isFinite(na) && Number.isFinite(nb) ? (na > nb ? "a" : nb > na ? "b" : null) : null;
  const cell = (v, sub, side) =>
    `<div class="v${lead === side ? ` lead-${side}` : ""}">${esc(v)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  return el("div", "row", `<div class="label">${esc(label)}</div>${cell(a, subA, "a")}${cell(b, subB, "b")}`);
}

export const CARDS = {
  // ---- serve: the headline exact tier ------------------------------------
  serve(s) {
    const e = s.exact;
    if (e) {
      if (!e.serve.reliable) return null;      // demoted rather than shown wrong
      const rows = [
        statRow("Service games won", `${e.holds[0]}/${e.served[0]}`, `${e.holds[1]}/${e.served[1]}`,
          pct(e.holds[0], e.served[0]), pct(e.holds[1], e.served[1])),
        statRow("Breaks of serve", e.breaks[0], e.breaks[1],
          `${e.breaksThisSet[0]} this set`, `${e.breaksThisSet[1]} this set`),
        statRow("Break points saved", `${e.bp[0].saved}/${e.bp[0].faced}`, `${e.bp[1].saved}/${e.bp[1].faced}`,
          pct(e.bp[0].saved, e.bp[0].faced), pct(e.bp[1].saved, e.bp[1].faced)),
      ];
      return { title: "Serve", rows };
    }
    if (!CFG.sampled || !s.sampled) return null;
    const sp = s.sampled;
    return {
      title: "Serve",
      rows: [statRow("Service points won", `${sp.serveWon}/${sp.servePlayed}`, "—", pct(sp.serveWon, sp.servePlayed), "")],
      approx: sp,
    };
  },

  // ---- games: set by set, run, momentum ----------------------------------
  games(s) {
    const e = s.exact;
    const sets = (s.sets || []).map((x, i) => `<div class="s">${x[0]}–${x[1]}<em>Set ${i + 1}</em></div>`).join("");
    if (!sets) return null;
    const rows = [el("div", "row wide", `<div class="label">Games</div><div class="sets">${sets}</div>`)];
    if (e && e.momentum.length) {
      const strip = e.momentum.map((w, i) =>
        `<i class="${w === 0 ? "a" : "b"}${i === e.momentum.length - 1 ? " now" : ""}"></i>`).join("");
      rows.push(el("div", "row wide", `<div class="label">Last ${e.momentum.length} games</div><div class="momentum">${strip}</div>`));
    }
    if (e && e.run.side !== null && e.run.n > 1) {
      const who = teamLabel(s.teams?.[e.run.side]);
      rows.push(statRow("Games in a row", e.run.side === 0 ? e.run.n : "—", e.run.side === 1 ? e.run.n : "—", who, who));
    }
    return { title: "Games", rows };
  },

  // ---- points: exact from the log, or sampled and labelled ---------------
  points(s) {
    const e = s.exact;
    if (e) {
      const tot = e.points[0] + e.points[1];
      if (!tot) return null;
      return {
        title: "Points",
        rows: [
          statRow("Points won", e.points[0], e.points[1], pct(e.points[0], tot), pct(e.points[1], tot)),
          statRow("On serve", `${e.servePoints[0].won}/${e.servePoints[0].played}`,
            `${e.servePoints[1].won}/${e.servePoints[1].played}`,
            pct(e.servePoints[0].won, e.servePoints[0].played), pct(e.servePoints[1].won, e.servePoints[1].played)),
        ],
      };
    }
    if (!CFG.sampled || !s.sampled) return null;
    const sp = s.sampled;
    const tot = sp.points[0] + sp.points[1];
    if (!tot) return null;
    return {
      title: "Points",
      rows: [statRow("Points won", sp.points[0], sp.points[1], pct(sp.points[0], tot), pct(sp.points[1], tot))],
      approx: sp,
    };
  },

  // ---- time: exact set durations, observed game durations ----------------
  time(s) {
    const rows = [];
    if (s.durations?.length) {
      const sets = s.durations.map((d) => `<div class="s">${esc(d.text)}<em>Set ${d.set}</em></div>`).join("");
      rows.push(el("div", "row wide", `<div class="label">Set duration</div><div class="sets">${sets}</div>`));
    }
    if (s.longestGame) {
      const avg = s.gameDurations.reduce((n, g) => n + g.seconds, 0) / s.gameDurations.length;
      rows.push(statRow("Longest game", mins(s.longestGame.seconds), mins(Math.round(avg)), "watched", "average"));
    }
    return rows.length ? { title: "Time on court", rows } : null;
  },

  // ---- context: history from the D1 stats APIs ---------------------------
  context(s) {
    if (ctx.state !== "ready" || !ctx.data) return null;
    const { A, B, matchup, elo } = ctx.data;
    const rows = [];
    const pair = matchup?.pair;
    if (pair?.n) {
      rows.push(statRow("Previous meetings", pair.aWins, pair.bWins, `${pair.n} played`, `${pair.n} played`));
      if (pair.sets && pair.sets.a + pair.sets.b) rows.push(statRow("Sets between them", pair.sets.a, pair.sets.b));
    }
    // Only compare ratings from the same pool — a men's FIP rating against a
    // women's RankedIn one is not a comparison, it is a category error.
    const rate = (side) => side.map((p) => elo[p.id]).filter(Boolean);
    const ra = rate(A), rb = rate(B);
    const pool = ra[0] && rb[0] && ra[0].source === rb[0].source && ra[0].pool === rb[0].pool;
    if (pool) {
      const avg = (r) => Math.round(r.reduce((n, x) => n + x.rating, 0) / r.length);
      const rank = (r) => r.map((x) => `#${x.rank}`).join(" / ");
      rows.push(statRow("Elo rating", avg(ra), avg(rb), rank(ra), rank(rb)));
    }
    if (!rows.length) return null;
    return { title: "History", sub: pair?.n ? "head to head" : "", rows };
  },
};

export function renderCard(def, s) {
  const card = el("div", "card");
  const head = el("header");
  head.append(el("h1", null, esc(def.title)));
  const sub = def.sub || (s.teams ? `${teamLabel(s.teams[0])} vs ${teamLabel(s.teams[1])}` : "");
  if (sub) head.append(el("div", "sub", esc(sub)));
  card.append(head);

  const grid = el("div", "grid");
  if (s.teams) {
    grid.append(el("div", "names",
      `<div></div><div class="n a">${esc(teamLabel(s.teams[0]))}</div><div class="n b">${esc(teamLabel(s.teams[1]))}</div>`));
  }
  for (const r of def.rows) grid.append(r);
  card.append(grid);

  // Sampled numbers never go up unlabelled.
  if (def.approx) {
    const bad = def.approx.gamesUnreliable;
    card.append(el("div", "foot approx",
      `Approximate — sampled from polling${bad ? ` · ${bad} game${bad > 1 ? "s" : ""} not counted` : ""}`));
  }
  return card;
}

// ---------------------------------------------------------------------------
// the card scheduler
// ---------------------------------------------------------------------------

let rotation = 0;
let running = null;          // timers for the changeover in progress

/**
 * Which cards to show for this changeover, most relevant first.
 * `spin` rotates the tail so consecutive changeovers do not repeat the same two
 * cards; fire() passes an incrementing counter.
 */
export function chooseCards(kind, s, prevStats, spin = 0) {
  const order = ["serve", "games", "points", "time", "context"];
  // A break of serve is the story; a completed set puts the games card first.
  const broke = prevStats?.exact && s.exact &&
    (s.exact.breaks[0] + s.exact.breaks[1]) > (prevStats.exact.breaks[0] + prevStats.exact.breaks[1]);
  if (broke) order.unshift(...order.splice(order.indexOf("serve"), 1));
  else if (kind === TRIGGER.SET_BREAK) order.unshift(...order.splice(order.indexOf("games"), 1));

  const built = order.map((k) => ({ k, def: CARDS[k](s) })).filter((x) => x.def);
  if (!built.length) return [];
  // Rotate the tail so consecutive changeovers do not repeat the same two cards.
  const head = built.slice(0, 1);
  const tail = built.slice(1);
  const spun = tail.length ? tail.slice(spin % tail.length).concat(tail.slice(0, spin % tail.length)) : [];
  return head.concat(spun);
}

function clearCards() {
  if (running) { running.forEach(clearTimeout); running = null; }
  stage.replaceChildren();
}

function fire(trigger, s, prevStats) {
  const window = WINDOW[trigger.kind] ?? 60;
  const budget = window - CFG.delay - SAFETY;
  if (budget < 12) {
    say(`skip ${trigger.kind}: ${window}s break minus ${CFG.delay}s delay leaves no room`);
    return;
  }
  const cards = chooseCards(trigger.kind, s, prevStats, rotation++);
  if (!cards.length) { say(`skip ${trigger.kind}: nothing worth showing yet`); return; }

  const total = Math.min(CFG.show, budget);
  const n = Math.min(cards.length, trigger.kind === TRIGGER.TIEBREAK ? 1 : 3);
  const per = total / n;

  clearCards();
  running = [];
  say(`${trigger.kind} → ${cards.slice(0, n).map((c) => c.k).join(", ")} (+${CFG.delay}s, ${Math.round(total)}s)`);

  for (let i = 0; i < n; i++) {
    const at = (CFG.delay + i * per) * 1000;
    running.push(setTimeout(() => {
      stage.replaceChildren();
      const node = renderCard(cards[i].def, s);
      stage.append(node);
      requestAnimationFrame(() => node.classList.add("in"));
    }, at));
    // Fade the last one out early enough that it is gone before play resumes.
    if (i === n - 1) {
      running.push(setTimeout(() => stage.querySelector(".card")?.classList.remove("in"), at + per * 1000 - 400));
      running.push(setTimeout(() => stage.replaceChildren(), at + per * 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

let state = null;
let prevStats = null;
let polls = 0, fails = 0;

async function tick() {
  try {
    const obs = CFG.tid ? await pollSporteaser() : CFG.event ? await pollCrionet() : null;
    polls++;
    if (!obs) {
      say(`poll ${polls}: no match matched the selector`);
      return;
    }
    fails = 0;
    if (!state || state.matchId !== obs.matchId) {
      state = loadState(obs.matchId, safeStorage());
      ctx.state = "idle";
      ctx.data = null;
      say(`following ${obs.matchId} — ${obs.teams ? `${teamLabel(obs.teams[0])} vs ${teamLabel(obs.teams[1])}` : "?"}`);
    }
    const { trigger, stats } = ingest(state, obs);
    saveState(state, safeStorage());
    if (ctx.state === "idle") loadContext(obs);

    if (CFG.debug) {
      const e = stats.exact;
      say(`poll ${polls} ${obs.status} ${(obs.sets || []).map((x) => x.join("-")).join(" ")}` +
          `${obs.points ? ` [${obs.points.join(":")}]` : ""}` +
          `${e ? ` · exact holds ${e.holds.join("/")} breaks ${e.breaks.join("/")} serve ${(e.serve.confidence * 100) | 0}%` : " · sampled"}`);
    }
    if (trigger) fire(trigger, stats, prevStats);
    prevStats = stats;
  } catch (err) {
    fails++;
    say(`poll failed (${fails}): ${err.message}`, true);
    // Upstream blips are expected. The overlay keeps its accumulated state and
    // simply retries — it never clears a card because a fetch failed.
  }
}

function safeStorage() {
  try { return window.localStorage; } catch { return null; }
}

// `preview=<card>` pins one card up so the source can be positioned in OBS
// without waiting for a real changeover. Never use it on air.
function previewLoop() {
  const s = prevStats;
  if (!s) return;
  const def = CARDS[CFG.preview]?.(s);
  stage.replaceChildren();
  if (!def) { say(`preview: "${CFG.preview}" has nothing to render yet`); return; }
  const node = renderCard(def, s);
  stage.append(node);
  requestAnimationFrame(() => node.classList.add("in"));
}

function boot() {
  document.documentElement.dataset.theme = CFG.theme;
  document.documentElement.style.setProperty("--scale", String(CFG.scale));
  stage = document.getElementById("stage");
  dbg = document.getElementById("debug");
  stage.dataset.pos = CFG.pos;
  if (CFG.debug) dbg.classList.remove("hidden");

  if (!CFG.tid && !CFG.event) {
    dbg.classList.remove("hidden");
    say("need ?tid=<sporteaserTournamentId>&day=<dayOfMonth> or ?event=<FIP-YYYY-NNNN>", true);
    return;
  }
  if (CFG.tid && !CFG.day) say("no &day= given — sporteaser needs a day-of-month", true);
  say(`polling every ${CFG.poll}ms · delay ${CFG.delay}s · ${CFG.sampled ? "sampled on" : "exact only"}`);
  tick();
  setInterval(tick, CFG.poll);
  if (CFG.preview) setInterval(previewLoop, 2000);
}

// Only take over the page when there IS a page. test/render.js imports this
// module against a synthetic DOM to render every card offline, and must not
// start a poll loop by doing so.
if (typeof document !== "undefined" && document.getElementById("stage")) boot();
