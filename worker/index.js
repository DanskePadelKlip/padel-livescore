// PadelTicker refresh — the scheduled edge worker the README always promised.
// Replaces the GitHub-Actions cron (which GitHub throttled to every 4–14 h — fatal
// for a livescore) and the laptop daemon as the primary data producer.
//
//   cron (every minute) ──► due? ──► aggregate() ──► KV: matches.json + health.json
//                                        │                (+ rankings ~6h, calendar ~weekly)
//                                        └─► alerts webhook + Web Push (diff vs prev)
//
// The site reads these blobs through functions/data/*.json.js (KV-first, static
// fallback), so the UI/SSR/health endpoints didn't change at all. Static deploys
// go back to meaning what they should: shipping CODE, not data.
//
// Self-pacing: the cron fires every minute, but each run stores when the next one
// is actually due — live matches → every minute, upcoming → 10 min, idle → 30 min,
// error → 5 min (same ladder as scripts/refresh-loop.js). A not-yet-due firing
// costs one KV read.
//
// NOTE: needs the $5/mo Workers Paid plan. A live cycle fans out well past the
// free tier's 50-subrequest cap (≈19 tournaments × matches + rankings + FIP/ts
// pages), and 60s live cadence exceeds 1000 KV writes/day.
//
// Deploy (from repo root):    npx wrangler deploy -c worker/wrangler.toml
// Secrets (once):             npx wrangler secret put VAPID_PRIVATE_KEY -c worker/wrangler.toml
//                             npx wrangler secret put ALERT_WEBHOOK_URL -c worker/wrangler.toml   (optional)

import { aggregate } from "../src/aggregate.js";
import { fetchRankings } from "../src/rankings.js";
import { attachSourceHistory } from "../src/health-history.js";
import { newlyLive, newlySoon, sendAlerts, sendSoonAlerts } from "../src/alerts.js";
import { fanOut, livePayload, soonPayload, VAPID_PUBLIC_KEY, VAPID_SUBJECT } from "../src/push-core.js";
import { sendNotification } from "../src/webpush.js";
import { setClubStore } from "../src/rankedin-club.js";
import { isoWeekKey, applyMovement } from "../src/rank-movement.js";
import { buildCalendar } from "../src/calendar-refresh.js";

const LIVE_MS = 60_000;            // ≥1 live match  -> ~1 min (feels live)
const UPCOMING_MS = 10 * 60_000;   // matches upcoming -> 10 min
const IDLE_MS = 30 * 60_000;       // nothing on -> 30 min
const ERROR_MS = 5 * 60_000;
const RANKINGS_MS = 6 * 3600_000;  // rankings move ~weekly; 6h matches the daemon
const CALENDAR_MS = 7 * 24 * 3600_000;

export default {
  // Peek endpoint for debugging/monitoring the pipeline itself (the public site
  // health lives at padelticker.com/api/health): shows the pacing state and how
  // old the current KV snapshot is.
  async fetch(request, env) {
    const [state, matches] = await Promise.all([
      env.LIVE.get("state", "json"),
      env.LIVE.get("matches.json", "json"),
    ]);
    return new Response(JSON.stringify({
      state,
      dataGeneratedAt: matches?.generatedAt || null,
      dataAgeMin: matches?.generatedAt ? Math.round((Date.now() - Date.parse(matches.generatedAt)) / 60000) : null,
      matchCount: matches?.count ?? null,
    }, null, 2), { headers: { "content-type": "application/json" } });
  },

  async scheduled(event, env, ctx) {
    const startedAt = Date.now();
    const state = (await env.LIVE.get("state", "json")) || {};
    if (state.nextDueAt && startedAt < state.nextDueAt - 5000) return; // not due yet (5s cron jitter slack)

    // Lease-style claim BEFORE the slow work, so a cycle that outlives the next
    // cron firing isn't run twice. (KV isn't a real lock, but cron invocations
    // land in the same colo, where read-after-write is dependable.)
    state.nextDueAt = startedAt + LIVE_MS;
    await env.LIVE.put("state", JSON.stringify(state));

    // organiser cache persisted in KV (the .cache/ file's role in Node)
    setClubStore({
      load: () => env.LIVE.get("clubs", "json"),
      save: (entries) => ctx.waitUntil(env.LIVE.put("clubs", JSON.stringify(entries))),
    });

    let delay = ERROR_MS;
    try {
      const date = new Date().toISOString().slice(0, 10);
      const log = (m) => console.log(m);

      const prev = await env.LIVE.get("matches.json", "json");
      const { matches, sources } = await aggregate({ date, log });
      const counts = matches.reduce((a, m) => ((a[m.status] = (a[m.status] || 0) + 1), a), {});

      // ---- alerts + Web Push: diff against the previous snapshot ------------
      if (env.ALERT_WEBHOOK_URL || env.VAPID_PRIVATE_KEY) {
        const prevAt = Date.parse(prev?.generatedAt) || startedAt - 15 * 60_000;
        const fresh = newlyLive(prev?.matches, matches);
        const soon = newlySoon(prev?.matches, prevAt, matches, startedAt, 20 * 60_000);
        if (fresh.length || soon.length) log(`🔔 ${fresh.length} newly live · ${soon.length} starting soon`);
        if (env.ALERT_WEBHOOK_URL) {
          if (fresh.length) await sendAlerts(fresh, env.ALERT_WEBHOOK_URL);
          if (soon.length) await sendSoonAlerts(soon, env.ALERT_WEBHOOK_URL);
        }
        if (env.VAPID_PRIVATE_KEY && (fresh.length || soon.length)) {
          await pushFanOut(env, fresh, soon, log);
        }
      }

      // ---- the live feed ----------------------------------------------------
      await env.LIVE.put("matches.json", JSON.stringify({
        generatedAt: new Date().toISOString(), date, count: matches.length, matches,
        producer: "worker", // tells scripts/fetch-live.js to leave alerts to us
      }));

      // ---- rankings (~6h) + weekly movement baselines ------------------------
      if (!state.rankingsAt || startedAt - state.rankingsAt > RANKINGS_MS) {
        try {
          const lists = await fetchRankings({ log });
          if (lists.length) {
            const [base, prevRankings] = await Promise.all([
              env.LIVE.get("rankings-base.json", "json"),
              env.LIVE.get("rankings.json", "json"),
            ]);
            const baseToWrite = applyMovement(lists, base, prevRankings?.lists || [], isoWeekKey());
            await env.LIVE.put("rankings-base.json", JSON.stringify(baseToWrite));
            await env.LIVE.put("rankings.json", JSON.stringify({ generatedAt: new Date().toISOString(), lists }));
            state.rankingsCount = lists.length;
          }
          state.rankingsAt = startedAt; // even on 0 lists — retry on the next window, not every cycle
        } catch (e) {
          console.error("rankings refresh failed:", e.message);
        }
      }

      // ---- pro calendar (~weekly, parse-guarded) -----------------------------
      if (!state.calendarAt || startedAt - state.calendarAt > CALENDAR_MS) {
        state.calendarAt = startedAt; // a failing parse retries next week, not every cycle
        try {
          const cal = await buildCalendar({ today: date });
          await env.LIVE.put("calendar.json", JSON.stringify(cal));
          log(`calendar refreshed: ${cal.events.length} Premier Padel events`);
        } catch (e) {
          console.error("calendar refresh skipped:", e.message);
        }
      }

      // ---- health snapshot (lastOkAt carried from the previous KV snapshot) --
      const prevHealth = await env.LIVE.get("health.json", "json");
      const sourcesWithHistory = await attachSourceHistory(sources, { prev: prevHealth });
      await env.LIVE.put("health.json", JSON.stringify({
        generated_at: new Date().toISOString(),
        total: matches.length,
        sources: sourcesWithHistory,
        rankings: state.rankingsCount || 0,
        byStatus: counts,
        producer: "worker",
      }));

      // every source dark = an outage, not a quiet day — retry on the error ladder
      const allDown = sources.length && sources.every((s) => s.ok === false);
      delay = allDown ? ERROR_MS : counts.live ? LIVE_MS : counts.upcoming ? UPCOMING_MS : IDLE_MS;
      log(`cycle ${allDown ? "DEGRADED (all sources failed)" : "ok"}: ${matches.length} matches (${JSON.stringify(counts)}) — next in ${delay / 60000} min`);
    } catch (e) {
      console.error("cycle failed:", e.stack || e.message);
      delay = ERROR_MS;
    }

    state.nextDueAt = startedAt + delay;
    await env.LIVE.put("state", JSON.stringify(state));
  },
};

// Web Push fan-out via the shared core (src/push-core.js) with the WebCrypto
// sender and the native D1 binding — same subscriptions table, same matching and
// payloads as the Node sender in src/push-send.js.
async function pushFanOut(env, fresh, soon, log) {
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
