// PadelTicker refresh worker — the FALLBACK data producer (free Workers plan).
//
// The PRIMARY producer is the laptop daemon (scripts/refresh-loop.js): full
// pipeline, 1-min live cadence, deploys static files. This worker exists for
// when that machine is asleep: every cron firing it peeks at the live feed —
// if the daemon has produced recently it STANDS DOWN (cost: one fetch); once
// the feed goes stale it takes over at a gentler cadence, writing blobs to D1
// that functions/data/*.json.js serve whenever they're fresher than the static
// files. When the daemon wakes and deploys, its data is fresher again and the
// worker steps back automatically. No coordination, freshest data wins.
//
//   cron (*/2) ─► daemon fresh? ──yes──► return (standby)
//                     │no
//                     ▼
//        most-overdue source of: rankedin | fip | ts | rankings | calendar
//                     ▼
//        fetch that ONE source ─► merge with the other sources' D1 blobs
//                     ▼
//        D1: src:<id> + matches.json + health.json (+ alerts/Web Push diff)
//
// FREE-PLAN BUDGETS (why one source per firing):
//   · ≤50 subrequests/invocation — each source alone fits (rankedin ≈5+events,
//     fip ≈12, ts ≈27, rankings 24); a full cycle would not.
//   · 10 ms CPU/invocation — fine for the JSON sources; tournamentsoftware's
//     HTML parse is the tight one. If a slot blows the limit the invocation
//     dies, last-good data persists, and the slot retries next window.
//   · D1 free tier (100k row-writes/day) replaces KV (1k/day — too few).
//
// Deploy (from repo root):    npx wrangler deploy -c worker/wrangler.toml
// Secrets (once, optional):   npx wrangler secret put VAPID_PRIVATE_KEY -c worker/wrangler.toml
//                             npx wrangler secret put ALERT_WEBHOOK_URL -c worker/wrangler.toml

import * as rankedinAdapter from "../src/adapters/rankedin.js";
import * as fipAdapter from "../src/adapters/fip.js";
import * as tsAdapter from "../src/adapters/tournamentsoftware.js";
import { mergeMatches } from "../src/aggregate.js";
import { assertMatch } from "../src/schema.js";
import { fetchRankings } from "../src/rankings.js";
import { newlyLive, newlySoon, sendAlerts, sendSoonAlerts } from "../src/alerts.js";
import { fanOut, livePayload, soonPayload, VAPID_PUBLIC_KEY, VAPID_SUBJECT } from "../src/push-core.js";
import { sendNotification } from "../src/webpush.js";
import { setClubStore } from "../src/rankedin-club.js";
import { isoWeekKey, applyMovement } from "../src/rank-movement.js";
import { buildCalendar } from "../src/calendar-refresh.js";

const SITE = "https://padelticker.com";
// The daemon writes matches.json every cycle, even idle (≤30 min apart). A feed
// fresher than this that ISN'T ours means the daemon is alive → stand down.
const DAEMON_FRESH_MS = 35 * 60_000;

// Fallback cadence — deliberately gentler than the daemon's 1-min live pace.
const CAD = {
  liveMs: 5 * 60_000,       // source has live matches
  upcomingMs: 15 * 60_000,  // only upcoming
  idleMs: 30 * 60_000,      // nothing on
  tsMs: 20 * 60_000,        // tournamentsoftware: schedules/results, flat
  rankingsMs: 12 * 3600_000,
  calendarMs: 7 * 24 * 3600_000,
};

// Match sources in ADAPTERS order (src/aggregate.js) so merge precedence is
// identical to the daemon's: rankedin, then fip, then ts win on duplicate ids.
const SOURCES = [
  { id: "rankedin", mod: rankedinAdapter },
  { id: "fip", mod: fipAdapter },
  { id: "tournamentsoftware", mod: tsAdapter },
];
const SLOTS = [...SOURCES.map((s) => s.id), "rankings", "calendar"];

let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS live_blobs (key TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
  tableReady = true;
}
const getBlob = async (env, key) =>
  JSON.parse((await env.DB.prepare("SELECT body FROM live_blobs WHERE key = ?").bind(key).first())?.body ?? "null");
const putBlob = (env, key, value) =>
  env.DB.prepare(
    "INSERT INTO live_blobs (key, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET body = ?2, updated_at = ?3"
  ).bind(key, JSON.stringify(value), new Date().toISOString()).run();

export default {
  // Peek endpoint: is the worker standing by or producing, and how old is what?
  async fetch(request, env) {
    await ensureTable(env);
    const [meta, matches] = await Promise.all([getBlob(env, "meta"), getBlob(env, "matches.json")]);
    return new Response(JSON.stringify({
      mode: meta?.standby ? "standby (daemon is producing)" : "active (fallback producer)",
      lastCheckAt: meta?.checkedAt || null,
      slots: meta?.next || null,
      blobGeneratedAt: matches?.generatedAt || null,
      blobMatchCount: matches?.count ?? null,
    }, null, 2), { headers: { "content-type": "application/json" } });
  },

  async scheduled(event, env, ctx) {
    const now = Date.now();
    await ensureTable(env);
    const meta = (await getBlob(env, "meta")) || { next: {} };
    meta.checkedAt = new Date(now).toISOString();

    // ---- standby check: is the daemon (or CI) producing? --------------------
    let feed = null;
    try {
      feed = await (await fetch(`${SITE}/data/matches.json?_=${now}`, { signal: AbortSignal.timeout(8000) })).json();
    } catch {
      // site unreachable — assume we're needed rather than leave the feed dark
    }
    const feedAt = Date.parse(feed?.generatedAt) || 0;
    if (feed?.producer !== "worker" && now - feedAt < DAEMON_FRESH_MS) {
      meta.standby = true;
      await putBlob(env, "meta", meta);
      return;
    }
    if (meta.standby) console.log("feed stale — taking over as fallback producer");
    meta.standby = false;

    // ---- pick the most-overdue slot (one per firing: free-plan budgets) -----
    const due = SLOTS.filter((k) => now >= (meta.next?.[k] || 0) - 5000);
    if (!due.length) { await putBlob(env, "meta", meta); return; }
    const slot = due.sort((a, b) => (meta.next?.[a] || 0) - (meta.next?.[b] || 0) || SLOTS.indexOf(a) - SLOTS.indexOf(b))[0];

    // lease before the slow work so a slow slot isn't started twice
    meta.next = { ...meta.next, [slot]: now + 60_000 };
    await putBlob(env, "meta", meta);

    setClubStore({
      load: () => getBlob(env, "clubs"),
      save: (entries) => ctx.waitUntil(putBlob(env, "clubs", entries)),
    });

    try {
      if (slot === "rankings") {
        meta.next.rankings = now + CAD.rankingsMs; // even on failure: retry next window
        const lists = await fetchRankings({ log: console.log });
        if (lists.length) {
          const [base, prevRankings] = await Promise.all([getBlob(env, "rankings-base.json"), getBlob(env, "rankings.json")]);
          const baseToWrite = applyMovement(lists, base, prevRankings?.lists || [], isoWeekKey());
          await putBlob(env, "rankings-base.json", baseToWrite);
          await putBlob(env, "rankings.json", { generatedAt: new Date().toISOString(), lists });
          meta.rankingsCount = lists.length;
        }
      } else if (slot === "calendar") {
        meta.next.calendar = now + CAD.calendarMs; // a failing parse retries next week
        const cal = await buildCalendar({ today: new Date().toISOString().slice(0, 10) });
        await putBlob(env, "calendar.json", cal);
        console.log(`calendar refreshed: ${cal.events.length} events`);
      } else {
        await runSourceSlot(env, slot, now, meta);
      }
    } catch (e) {
      // rankings/calendar re-armed themselves before the attempt; a source slot
      // that failed unexpectedly (adapter errors are handled inside runSourceSlot)
      // retries on the idle interval.
      console.error(`slot ${slot} failed:`, e.stack || e.message);
      if (SOURCES.some((s) => s.id === slot)) meta.next[slot] = now + CAD.idleMs;
    }
    await putBlob(env, "meta", meta);
  },
};

async function runSourceSlot(env, slot, now, meta) {
  const date = new Date().toISOString().slice(0, 10);
  const src = SOURCES.find((s) => s.id === slot);

  // previous per-source blobs (this slot's prev doubles as its last-good cache)
  const blobs = {};
  for (const s of SOURCES) blobs[s.id] = (await getBlob(env, `src:${s.id}`)) || { matches: [] };
  const prevMerged = await getBlob(env, "matches.json");

  let entry = blobs[slot];
  try {
    const matches = await src.mod.fetchMatches({ date, log: console.log });
    for (const m of matches) assertMatch(m);
    entry = { at: now, ok: true, error: null, lastOkAt: new Date(now).toISOString(), matches };
  } catch (e) {
    // keep last-good matches; record the failure for health
    entry = { ...entry, at: now, ok: false, error: String(e?.message || e).slice(0, 200) };
    console.error(`adapter ${slot} failed — ${entry.error}`);
  }
  blobs[slot] = entry;
  await putBlob(env, `src:${slot}`, entry);

  const merged = mergeMatches(SOURCES.map((s) => blobs[s.id].matches));
  const counts = merged.reduce((a, m) => ((a[m.status] = (a[m.status] || 0) + 1), a), {});

  // alerts + Web Push, diffed against whatever the site served before us
  if (entry.ok && (env.ALERT_WEBHOOK_URL || env.VAPID_PRIVATE_KEY)) {
    const prevAt = Date.parse(prevMerged?.generatedAt) || now - 15 * 60_000;
    const fresh = newlyLive(prevMerged?.matches, merged);
    const soon = newlySoon(prevMerged?.matches, prevAt, merged, now, 20 * 60_000);
    if (env.ALERT_WEBHOOK_URL) {
      if (fresh.length) await sendAlerts(fresh, env.ALERT_WEBHOOK_URL);
      if (soon.length) await sendSoonAlerts(soon, env.ALERT_WEBHOOK_URL);
    }
    if (env.VAPID_PRIVATE_KEY && (fresh.length || soon.length)) await pushFanOut(env, fresh, soon);
  }

  await putBlob(env, "matches.json", {
    generatedAt: new Date().toISOString(), date, count: merged.length, matches: merged,
    producer: "worker", // lets the standby check + scripts/fetch-live.js recognise our data
  });
  await putBlob(env, "health.json", {
    generated_at: new Date().toISOString(),
    total: merged.length,
    sources: SOURCES.map((s) => ({
      id: s.mod.id,
      ok: blobs[s.id].ok !== false,
      count: (blobs[s.id].matches || []).length,
      ...(blobs[s.id].ok === false ? { error: blobs[s.id].error } : {}),
      lastOkAt: blobs[s.id].lastOkAt || null,
    })),
    rankings: meta.rankingsCount || 0,
    byStatus: counts,
    producer: "worker",
  });

  // re-arm: per-source pacing from that source's own content
  const own = entry.matches || [];
  const hasLive = own.some((m) => m.status === "live");
  const hasUpcoming = own.some((m) => m.status === "upcoming");
  meta.next[slot] = now + (slot === "tournamentsoftware" ? CAD.tsMs : hasLive ? CAD.liveMs : hasUpcoming ? CAD.upcomingMs : CAD.idleMs);
  console.log(`slot ${slot}: ${own.length} matches (merged ${merged.length}, ${JSON.stringify(counts)}) — next in ${(meta.next[slot] - now) / 60000} min`);
}

// Web Push fan-out via the shared core (src/push-core.js) with the WebCrypto
// sender and the native D1 binding — same subscriptions table, same matching and
// payloads as the Node sender in src/push-send.js.
async function pushFanOut(env, fresh, soon) {
  const log = (m) => console.log(m);
  let subs;
  try {
    subs = (await env.DB.prepare("SELECT endpoint,p256dh,auth,follows FROM push_subscriptions").all()).results || [];
  } catch (e) {
    log(`   push: could not read subscriptions (D1) — ${e.message}`);
    return;
  }
  if (!subs.length) return;

  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || VAPID_SUBJECT,
  };
  const send = (s, payload) => sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, vapid);
  const prune = (endpoint) => env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();

  if (fresh.length) await fanOut(fresh, subs, livePayload, send, prune, log, "push(live)");
  if (soon.length) await fanOut(soon, subs, soonPayload, send, prune, log, "push(soon)");
}
