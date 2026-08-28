#!/usr/bin/env node
// Preflight for the changeover stats overlay.
//
//   node scripts/live-detail-check.js <padelfip event URL | slug>
//   node scripts/live-detail-check.js fip-gold-belgrade-2026
//   node scripts/live-detail-check.js --list          # events in play right now
//
// Answers the one question worth asking before going on air: will the overlay
// have anything to show for this event? Coverage is per-event, never tour-wide —
// an organiser configures live scoring (or does not), and picks Crionet or
// Sporteaser. This reports which, and what fields actually come back, so a blank
// overlay is diagnosed on the ground rather than mid-broadcast.
//
// Reuses the real discovery paths (fip.discoverActiveEvents / fip.matchscorerId /
// sporteaser.discoverTournamentId) — nothing here reimplements them.

import { parseHTML } from "linkedom";
import { discoverActiveEvents, matchscorerId, parseLiveBoard } from "../src/adapters/fip.js";
import * as sporteaser from "../src/adapters/sporteaser.js";
import { FIP_HEADERS, SPORTEASER_HEADERS, liveBoardUrl, sporteaserDayUrl } from "../src/live-detail.js";

const WP_EVENTS = "https://www.padelfip.com/wp-json/wp/v2/events";
const todayISO = () => new Date().toISOString().slice(0, 10);
const say = (...a) => console.log(...a);

// ---- resolving whatever the user typed into an event record ----------------

async function resolveEvent(arg) {
  if (/^https?:\/\//i.test(arg)) {
    const slug = arg.replace(/\/+$/, "").split("/").pop() || arg;
    return { slug, link: arg, title: slug, year: (slug.match(/-(\d{4})\b/) || [])[1] || String(new Date().getFullYear()) };
  }
  // Prefer the adapter's own discovery — it is what the live pipeline sees.
  const active = await discoverActiveEvents(todayISO(), () => {});
  const hit = active.find((e) => e.slug === arg) || active.find((e) => e.slug.includes(arg));
  if (hit) return hit;
  // Not "in play" (modified more than ~2 days ago): ask WordPress directly.
  const res = await fetch(`${WP_EVENTS}?slug=${encodeURIComponent(arg)}`, { headers: FIP_HEADERS });
  const [e] = await res.json();
  if (!e) return null;
  return {
    slug: e.slug,
    link: e.link,
    title: String(e.title?.rendered || e.slug).replace(/&#\d+;|&\w+;/g, " ").trim(),
    year: (e.slug.match(/-(\d{4})\b/) || [])[1] || String(new Date().getFullYear()),
  };
}

// ---- provider probes -------------------------------------------------------

async function probeCrionet(msId) {
  try {
    const res = await fetch(liveBoardUrl(msId), { headers: FIP_HEADERS });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const { document } = parseHTML(await res.text());
    const boards = parseLiveBoard(document);
    return {
      ok: true,
      onCourt: boards.length,
      warmup: boards.filter((b) => b.warmup).length,
      withPoints: boards.filter((b) => b.teams.some((t) => t.points)).length,
      withServe: boards.filter((b) => b.teams.some((t) => t.serving)).length,
      sample: boards[0] || null,
    };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

async function probeSporteaser(link, dayArg) {
  const tid = await sporteaser.discoverTournamentId(link, () => {});
  if (!tid) return { tid: null };
  // One raw day fetch: fetchDay() normalizes away the very fields we need to
  // report on (pointHistory in particular), so the probe reads the payload itself.
  const day = dayArg || new Date().getUTCDate();
  const res = await fetch(sporteaserDayUrl(tid, day), { headers: SPORTEASER_HEADERS });
  if (!res.ok) return { tid, why: `HTTP ${res.status}` };
  const json = await res.json();
  const matches = json.matches || [];
  const live = matches.filter((m) => m.matchStatus === 2);
  const withLog = matches.filter((m) => m.pointHistory?.results?.length);
  return {
    tid,
    days: json.days || [],
    day,
    total: matches.length,
    live: live.length,
    final: matches.filter((m) => m.matchStatus === 4).length,
    upcoming: matches.filter((m) => m.matchStatus === 1).length,
    withLog: withLog.length,
    sample: live[0] || withLog[withLog.length - 1] || matches[0] || null,
  };
}

// ---- reporting -------------------------------------------------------------

const mark = (b) => (b ? "yes" : "no");

// Mirrors adapters/sporteaser.js serving(): the last game of the last set.
function sporteaserServing(m) {
  const sets = m.pointHistory?.results;
  const games = Array.isArray(sets) && sets.length ? sets[sets.length - 1] : null;
  const onServe = Array.isArray(games) && games.length ? games[games.length - 1]?.status?.onServe : null;
  return onServe && typeof onServe.homeOnServe === "boolean" ? (onServe.homeOnServe ? 0 : 1) : null;
}

function reportSporteaserSample(m) {
  const r = m.results || {};
  const sets = ["First", "Second", "Third"].filter(
    (p) => r[`matchHomeTeam${p}PeriodScore`] !== undefined || r[`matchAwayTeam${p}PeriodScore`] !== undefined
  ).length;
  const log = m.pointHistory?.results || [];
  const games = log.reduce((n, s) => n + (s?.length || 0), 0);
  const pts = log.reduce((n, s) => n + (s || []).reduce((k, g) => k + (g.points?.length || 0), 0), 0);
  const cur = r.matchHomeTeamCurrentStatus != null ? ` ("${r.matchHomeTeamCurrentStatus}"-"${r.matchAwayTeamCurrentStatus}")` : "";
  say(`      sample match  : ${m.homeTeam?.name} vs ${m.awayTeam?.name}`);
  say(`      court / round : ${m.fieldName || "?"} / ${m.round ?? "?"}`);
  say(`      set games     : ${mark(sets > 0)}${sets ? ` (${sets} set(s) scored)` : ""}`);
  say(`      current game  : ${mark(r.matchHomeTeamCurrentStatus != null)}${cur}`);
  say(`      serving side  : ${mark(sporteaserServing(m) != null)}`);
  say(`      POINT LOG     : ${mark(games > 0)}${games ? ` — ${log.length} set(s), ${games} game(s), ${pts} logged point(s)` : ""}`);
  if (m.pointHistory?.meta?.duration) say(`      set durations : ${JSON.stringify(m.pointHistory.meta.duration)}`);
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const arg = argv[0];
  const dayArg = Number((argv.find((a) => a.startsWith("--day=")) || "").split("=")[1]) || null;
  if (!arg || arg === "--help" || arg === "-h") {
    say("usage: node scripts/live-detail-check.js <padelfip event URL | slug> [--day=N]");
    say("       node scripts/live-detail-check.js --list");
    process.exit(arg ? 0 : 1);
  }

  if (arg === "--list") {
    const active = await discoverActiveEvents(todayISO(), (m) => say(m));
    say(`\n${active.length} FIP event(s) touched in the last ~2 days:\n`);
    for (const e of active) say(`  ${e.slug}`);
    say(`\nRun this again with one of those slugs to probe its live scoring.`);
    return;
  }

  const ev = await resolveEvent(arg);
  if (!ev) {
    say(`no padelfip event matches "${arg}" — try --list`);
    process.exit(2);
  }
  say(`\nEvent : ${ev.title}`);
  say(`Slug  : ${ev.slug}`);
  say(`URL   : ${ev.link}\n`);

  const msId = await matchscorerId(ev);
  say(`Crionet (matchscorerlive)`);
  if (!msId) {
    say(`   ! no idEvent on the event page — this event has no Crionet feed at all.`);
  } else {
    say(`   event id      : ${msId}`);
    const c = await probeCrionet(msId);
    if (!c.ok) {
      say(`   live board    : unreachable (${c.why})`);
    } else {
      say(`   live board    : ${c.onCourt} match(es) on court right now${c.warmup ? ` (${c.warmup} in warm-up)` : ""}`);
      say(`   current game  : ${c.withPoints} with points`);
      say(`   serving side  : ${c.withServe} with a serve marker`);
      if (c.onCourt && c.sample) say(`   sample        : ${c.sample.teams.map((t) => t.players.join("/")).join("  vs  ")}`);
      if (!c.onCourt) {
        say(`   (an empty board is normal when nothing is on court — and is ALSO what a`);
        say(`    Sporteaser-scored event looks like at all times. Check Sporteaser below.)`);
      }
    }
  }

  say(`\nSporteaser`);
  const s = await probeSporteaser(ev.link, dayArg);
  if (!s.tid) {
    say(`   tournamentId  : none — no live-score widget configured for this event`);
  } else {
    say(`   tournamentId  : ${s.tid}`);
    if (s.why) {
      say(`   day feed      : unreachable (${s.why})`);
    } else {
      say(`   play days     : ${s.days.join(", ") || "(none)"}   (day-of-month, not ordinals)`);
      say(`   day ${s.day}        : ${s.total} match(es) — ${s.live} live, ${s.upcoming} upcoming, ${s.final} final`);
      say(`   with point log: ${s.withLog}/${s.total}`);
      if (s.sample) reportSporteaserSample(s.sample);
    }
  }

  // ---- verdict -------------------------------------------------------------
  say(`\nVerdict`);
  if (s.tid && s.withLog) {
    say(`   Sporteaser, WITH a point log. The overlay gets its exact tier:`);
    say(`   holds/breaks, break points, points won, service points, set durations.`);
    say(`   Overlay params:  ?tid=${s.tid}&day=<day-of-month>&court=<court>`);
  } else if (s.tid) {
    say(`   Sporteaser is configured but no match has a point log yet (nothing played`);
    say(`   on this day, or scoring not started). Re-run once the first match is under way.`);
    say(`   Overlay params:  ?tid=${s.tid}&day=<day-of-month>&court=<court>`);
  } else if (msId) {
    say(`   Crionet only. The board carries current state (set games, game points,`);
    say(`   serving side) but NO point log, so the overlay's point/serve counters are`);
    say(`   sampled by polling — run it with &sampled=1 to show them, labelled.`);
    say(`   Overlay params:  ?event=${msId}&court=<court>`);
  } else {
    say(`   No live scoring on either provider. The overlay will have nothing to show.`);
  }
  say("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
