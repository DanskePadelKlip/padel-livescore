// Changeover stats accumulator — the whole brain of the overlay.
//
// Dependency-free ES module, loaded unbundled by public/overlay/stats.js in the
// browser AND imported directly by test/replay.js in Node. One copy, both places:
// the maths that goes on air is the maths the fixtures test.
//
// ---------------------------------------------------------------------------
// WHAT THE PROVIDERS ACTUALLY GIVE US  (measured 2026-08-29 against FIP Gold
// Belgrade, sporteaser tournamentId 397 — 40 matches, 748 games, 3911 points)
// ---------------------------------------------------------------------------
//
// SPORTEASER ships a full point log: `pointHistory.results` is set -> game ->
// {status, points[], score}. Every point in the match is there, with a `worth`
// marker ("BP"/"SP"/"MP"), plus exact per-set durations in `pointHistory.meta`.
// This was NOT assumed going in — the build brief said neither provider logs
// points — so everything below is written against what the payload measurably
// contains, and each claim carries the check that established it:
//
//   * The DECIDING point of a game is never listed. The last entry is the state
//     BEFORE the winning point (game 1 ends "30:40" and the returner takes it).
//     Verified on all 760 scored games: the last state is always one point from
//     over for the side that went on to win.  -> points in a game = points.length + 1
//
//   * `status.onServe.homeOnServe` (who served the game) is WRONG about 4% of the
//     time: 21 of 85 sets have a non-alternating server sequence, which the rules
//     of the sport forbid. So the server is RECONSTRUCTED from strict alternation
//     by cumulative game index, with the parity chosen by majority vote over the
//     flags (94.4% agreement overall, median match 100%, worst 69%). The fit is
//     reported as `serve.confidence` and anything serve-derived is demoted when
//     it drops — see SERVE_MIN_CONFIDENCE.
//
//   * `serverWonGame` inherits that same bad flag (30/748 disagree with the score
//     delta), so it is ignored entirely: a hold/break is (reconstructed server ===
//     game winner), which cannot be wrong if the parity is right.
//
//   * In tiebreaks the per-point `homeOnServe` flags fail the 1-2-2 serve pattern
//     in 3 of 12 tiebreaks, so they are ignored too and the TB serve order is
//     derived from the rule instead.
//
// CRIONET (widget.matchscorerlive.com `tournamentlive`) publishes CURRENT STATE
// ONLY — set games, the current game score, a serve marker. No log. On that feed
// the point-level counters can only be SAMPLED by diffing polls, which is what
// the sampled tier below does, and which is why it is opt-in and labelled.
//
// The two tiers never mix: `exact` is present only when a point log is, and the
// renderer must never present a sampled number as an exact one.

// ---------------------------------------------------------------------------
// scoring vocabulary
// ---------------------------------------------------------------------------

const ORD = { 0: 0, "00": 0, 15: 1, 30: 2, 40: 3, AD: 4, A: 4, ADV: 4 };
const ordOf = (v) => {
  const k = String(v).trim().toUpperCase();
  return ORD[k] !== undefined ? ORD[k] : Number.isFinite(+k) ? +k : null;
};

/** Split a "40:30" / "6:1" point-state string into a numeric pair. */
function statePair(value, tb) {
  const [a, b] = String(value || "").split(":");
  return tb ? [parseInt(a, 10) || 0, parseInt(b, 10) || 0] : [ordOf(a), ordOf(b)];
}

/**
 * Who won the point that moved the game from `prev` to `cur`.
 * A side's number going UP means it won; a side's number going DOWN means it lost
 * an advantage, so the OTHER side won ("40:AD" -> "40:40" is a point for A).
 */
function pointWinner(prev, cur) {
  const [pa, pb] = prev, [ca, cb] = cur;
  if (ca > pa) return 0;
  if (cb > pb) return 1;
  if (ca < pa) return 1;
  if (cb < pb) return 0;
  return null;
}

/** A set score that is finished: 6-4, 7-5, 7-6 — but not 6-5 or 5-3. */
export function setComplete(a, b) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi >= 6 && hi - lo >= 2) || hi === 7;
}

// ---------------------------------------------------------------------------
// provider -> observation
// ---------------------------------------------------------------------------

const PERIODS = ["First", "Second", "Third", "Fourth", "Fifth"];

/**
 * One raw sporteaser match record -> a provider-neutral observation.
 * `flip` orients the record onto the overlay's side A / side B when the caller
 * has decided the home team is not side A.
 */
export function fromSporteaser(m, at = Date.now(), flip = false) {
  const r = m?.results || {};
  const or2 = (pair) => (pair && flip ? [pair[1], pair[0]] : pair);

  const sets = [];
  for (const p of PERIODS) {
    const h = r[`matchHomeTeam${p}PeriodScore`];
    const a = r[`matchAwayTeam${p}PeriodScore`];
    if (h === undefined && a === undefined) break;
    sets.push(or2([h ?? 0, a ?? 0]));
  }
  // A set that has just started carries no period keys at all; the point log
  // still knows it exists, so pad rather than lose the set number.
  const log = m?.pointHistory?.results;
  if (Array.isArray(log)) while (sets.length < log.length) sets.push([0, 0]);

  const live = m?.matchStatus === 2;
  return {
    at,
    matchId: String(m?.id ?? ""),
    status: m?.matchStatus === 4 ? "final" : live ? "live" : "upcoming",
    court: m?.fieldName || null,
    round: m?.round ?? null,
    teams: or2([sideOf(m?.homeTeam, m?.homeTeamLineup), sideOf(m?.awayTeam, m?.awayTeamLineup)]),
    sets,
    // A finished match keeps stale "0"/"0" in the current-status fields, which
    // must never be shown as a live game score.
    points: live && r.matchHomeTeamCurrentStatus != null
      ? or2([String(r.matchHomeTeamCurrentStatus), String(r.matchAwayTeamCurrentStatus ?? "")])
      : null,
    log: Array.isArray(log) ? normalizeLog(log, flip) : null,
    setDurations: m?.pointHistory?.meta?.duration || null,
  };
}

function sideOf(team, lineup) {
  const names = String(team?.name || "").split("/").map((s) => s.trim()).filter(Boolean);
  return {
    name: names.join(" / ") || "TBD",
    players: names.map((name, i) => ({ name, country: lineup?.[i]?.player?.country?.name || null })),
  };
}

/** sporteaser pointHistory -> a flat, oriented list of games in play order. */
function normalizeLog(results, flip) {
  const out = [];
  for (let si = 0; si < results.length; si++) {
    const games = results[si] || [];
    let prevA = 0, prevB = 0;
    for (let gi = 0; gi < games.length; gi++) {
      const g = games[gi] || {};
      const tb = !!g.status?.isTieBreak;
      const sc = g.score;
      // A game with no `score` block is the one still being played (or a phantom
      // trailing entry at a set boundary) — it has no games-after and no winner.
      const after = sc
        ? flip
          ? [sc.matchAwayteamGameScore ?? 0, sc.matchHometeamGameScore ?? 0]
          : [sc.matchHometeamGameScore ?? 0, sc.matchAwayteamGameScore ?? 0]
        : null;
      const winner = after ? (after[0] > prevA ? 0 : after[1] > prevB ? 1 : null) : null;
      if (after) { prevA = after[0]; prevB = after[1]; }

      const points = (g.points || []).map((p) => {
        const [a, b] = statePair(p.value, tb);
        return { a: flip ? b : a, b: flip ? a : b, worth: p.worth || null };
      });
      // Skip the phantom empty entries that appear at some set boundaries: no
      // points AND no score is not a game that happened.
      if (!points.length && !after) continue;
      // The feed's own server flag is deliberately kept but never trusted on its
      // own — reconstructServe() only uses it to vote on the alternation parity.
      const flagged = typeof g.status?.onServe?.homeOnServe === "boolean"
        ? (g.status.onServe.homeOnServe ? (flip ? 1 : 0) : (flip ? 0 : 1))
        : null;
      out.push({ set: si, index: gi, tb, points, winner, gamesAfter: after, complete: !!after, flagged });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// serve reconstruction
// ---------------------------------------------------------------------------

// Below this fit, serve-derived numbers (holds, breaks, break points, service
// points) are marked low-confidence rather than presented as exact. 0.80 sits
// well under the 94.4% measured across a whole event but well above coin-flip.
export const SERVE_MIN_CONFIDENCE = 0.8;

/**
 * Serve alternates every game — a rule of the sport, and a tiebreak counts as one
 * game for the rotation. So the whole match is a single alternating sequence and
 * the only unknown is its parity. Fit that parity to the feed's flags by majority
 * vote and report how well it fits.
 */
export function reconstructServe(games) {
  let votes0 = 0, votes1 = 0;
  games.forEach((g, k) => {
    if (g.flagged === null || g.tb) return;      // TB flags are unreliable, see header
    if (g.flagged === k % 2) votes0++;
    else votes1++;
  });
  const parity = votes0 >= votes1 ? 0 : 1;
  const n = votes0 + votes1;
  return {
    parity,
    n,
    confidence: n ? Math.max(votes0, votes1) / n : 0,
    // side serving cumulative game k
    serverOf: (k) => (k % 2 === parity ? 0 : 1),
  };
}

/**
 * Server of each point of a tiebreak, by the 1-2-2 rule: the side whose turn it
 * is serves one point, then the sides alternate in pairs.
 */
const tbServerOf = (i, first) => (Math.floor((i + 1) / 2) % 2 === 0 ? first : 1 - first);

// ---------------------------------------------------------------------------
// exact tier — derived from the point log
// ---------------------------------------------------------------------------

const emptyPair = () => [0, 0];

/**
 * Everything the point log can prove, with no sampling anywhere.
 * Returns null when there is no log (Crionet events).
 */
export function exactFromLog(games) {
  if (!games || !games.length) return null;
  const serve = reconstructServe(games);

  // Advantage scoring vs golden point changes what counts as a break point:
  // under golden point 40:40 IS one point from a break, under advantage it is not.
  // The match tells us which it is — an "AD" state anywhere means advantage.
  const advantage = games.some((g) => !g.tb && g.points.some((p) => p.a === 4 || p.b === 4));

  const st = {
    serve: { parity: serve.parity, confidence: serve.confidence, reliable: serve.confidence >= SERVE_MIN_CONFIDENCE },
    advantage,
    games: { played: 0, won: emptyPair() },
    holds: emptyPair(),          // service games won, per side
    served: emptyPair(),         // service games played, per side
    breaks: emptyPair(),         // return games won, per side
    breaksThisSet: emptyPair(),
    bp: [{ faced: 0, saved: 0 }, { faced: 0, saved: 0 }],   // by the SERVER of the game
    bpConverted: emptyPair(),    // break points taken, by the returner
    points: emptyPair(),
    servePoints: [{ played: 0, won: 0 }, { played: 0, won: 0 }],
    perSet: [],                  // [{games:[a,b], breaks:[a,b], complete}]
    momentum: [],                // winners of the last 6 completed games, oldest first
    run: { side: null, n: 0 },
    tiebreaks: [],
    bpMarkerAgreement: null,     // how often our BP call matches the feed's own "BP"
  };

  let markerHit = 0, markerTot = 0;
  const curSet = () => games.length ? games[games.length - 1].set : 0;

  games.forEach((g, k) => {
    const server = serve.serverOf(k);
    const set = g.set;
    st.perSet[set] ||= { games: emptyPair(), breaks: emptyPair(), complete: false };

    // ---- points in this game -------------------------------------------------
    let prev = [0, 0];
    const won = emptyPair();
    const servedBy = [];
    g.points.forEach((p, i) => {
      const w = pointWinner(prev, [p.a, p.b]);
      if (w !== null) won[w]++;
      servedBy.push(g.tb ? tbServerOf(i, server) : server);
      prev = [p.a, p.b];
    });
    // The deciding point is never logged: award it to the winner of the game.
    if (g.complete && g.winner !== null) {
      won[g.winner]++;
      servedBy.push(g.tb ? tbServerOf(g.points.length, server) : server);
    }
    st.points[0] += won[0];
    st.points[1] += won[1];

    // ---- service points ------------------------------------------------------
    // Rebuild the per-point winners once more alongside their server, so a point
    // is credited to the side that actually served it (matters inside tiebreaks).
    let p2 = [0, 0];
    const winners = [];
    for (const p of g.points) {
      winners.push(pointWinner(p2, [p.a, p.b]));
      p2 = [p.a, p.b];
    }
    if (g.complete && g.winner !== null) winners.push(g.winner);
    winners.forEach((w, i) => {
      const s = servedBy[i];
      if (s === undefined || w === null) return;
      st.servePoints[s].played++;
      if (w === s) st.servePoints[s].won++;
    });

    // ---- break points --------------------------------------------------------
    // A break point is a state from which the RETURNER wins the game with the very
    // next point. Computed from our own reconstructed server rather than taken
    // from the feed's `worth`, which is derived from the flag we do not trust.
    if (!g.tb) {
      const ret = 1 - server;
      for (let i = 0; i < g.points.length; i++) {
        const s = [g.points[i].a, g.points[i].b];
        const rv = s[ret], sv = s[server];
        const isBP = rv === 4 || (rv === 3 && (advantage ? sv < 3 : sv <= 3));
        const marked = /BP/.test(g.points[i].worth || "");
        markerTot++;
        if (isBP === marked) markerHit++;
        if (!isBP) continue;
        st.bp[server].faced++;
        // Saved when the server takes the following point; the point after the
        // last logged state is the implied deciding one, won by the game winner.
        const next = i + 1 < winners.length ? winners[i + 1] : null;
        if (next === server) st.bp[server].saved++;
        else if (next === ret) st.bpConverted[ret]++;
      }
    }

    // ---- games, holds, breaks ------------------------------------------------
    if (g.complete && g.winner !== null) {
      st.games.played++;
      st.games.won[g.winner]++;
      st.perSet[set].games[g.winner]++;
      if (!g.tb) {
        st.served[server]++;
        if (g.winner === server) st.holds[server]++;
        else { st.breaks[g.winner]++; st.perSet[set].breaks[g.winner]++; }
      }
      st.momentum.push(g.winner);
      if (st.run.side === g.winner) st.run.n++;
      else st.run = { side: g.winner, n: 1 };
    }
    if (g.tb) {
      st.tiebreaks.push({ set, points: [...won], winner: g.winner, complete: g.complete });
    }
  });

  const cs = curSet();
  st.breaksThisSet = st.perSet[cs] ? [...st.perSet[cs].breaks] : emptyPair();
  st.perSet.forEach((s) => { s.complete = setComplete(s.games[0], s.games[1]); });
  st.momentum = st.momentum.slice(-6);
  st.bpMarkerAgreement = markerTot ? markerHit / markerTot : null;
  return st;
}

// ---------------------------------------------------------------------------
// sampled tier — for feeds that publish current state only (Crionet)
// ---------------------------------------------------------------------------

/**
 * Fold one state-only observation into the sampled counters by diffing against
 * the previous one. Every number this produces is approximate by construction:
 * a poll gap silently swallows points, so each game is reconciled when it ends
 * and marked unreliable rather than reported wrong.
 */
export function sampleStep(sampled, prev, obs) {
  const s = sampled;
  const gTotal = (sets) => (sets || []).reduce((n, x) => n + (x[0] || 0) + (x[1] || 0), 0);
  const nowGames = gTotal(obs.sets);
  const wasGames = prev ? gTotal(prev.sets) : nowGames;
  const tb = inTiebreak(obs.sets);

  // --- a point moved within the current game ---
  if (prev && prev.points && obs.points && nowGames === wasGames) {
    const a = statePair(`${prev.points[0]}:${prev.points[1]}`, tb);
    const b = statePair(`${obs.points[0]}:${obs.points[1]}`, tb);
    if (a[0] !== null && b[0] !== null && (a[0] !== b[0] || a[1] !== b[1])) {
      const w = pointWinner(a, b);
      // One step, one point. A jump of more than one step means the poller missed
      // something and this game's sampled counts can no longer be trusted.
      const step = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      if (w !== null && step === 1) {
        s.game.points[w]++;
        const server = obs.serving === null || obs.serving === undefined ? null : obs.serving;
        if (server !== null) {
          s.game.servePlayed++;
          if (w === server) s.game.serveWon++;
        }
        // A break point in the sampled world: the returner one point from the game.
        // Resolve the one that was standing BEFORE this point, then look at the new
        // state to see whether another is standing now.
        if (server !== null && !tb) {
          const ret = 1 - server;
          if (s.game.pendingBP !== null) {
            s.bp[server].faced++;
            if (w === server) s.bp[server].saved++;
            s.game.pendingBP = null;
          }
          const rv = b[ret], sv = b[server];
          if (rv === 4 || (rv === 3 && sv <= 3)) s.game.pendingBP = ret;
        }
      } else if (w !== null) {
        s.game.gap = true;
      }
    }
  }

  // --- the game ended ---
  if (prev && nowGames > wasGames) {
    const winner = gamesWinner(prev.sets, obs.sets);
    // The deciding point is never observed as a state change (the game score
    // resets instead), so a break point still standing when the game ends was
    // either converted by the returner or saved by the server winning the game.
    if (s.game.pendingBP !== null && winner !== null) {
      const server = 1 - s.game.pendingBP;
      s.bp[server].faced++;
      if (winner === server) s.bp[server].saved++;
      s.game.pendingBP = null;
    }
    const seen = s.game.points[0] + s.game.points[1];
    const need = inTiebreak(prev.sets) ? 7 : 4;
    // The deciding point is never observable on a state-only feed either: the game
    // score jumps straight back to 0-0 rather than showing the winning state. So
    // the winner is credited one implied point, exactly as the exact tier does.
    const winnerSeen = winner === null ? 0 : s.game.points[winner] + 1;
    // Reconciliation: whoever won the game must have won at least `need` points in
    // it. If the poller saw fewer, points were missed — say so instead of reporting
    // a number we know to be short.
    const ok = !s.game.gap && winner !== null && winnerSeen >= need;
    if (ok) {
      s.game.points[winner]++;
      if (prev.serving !== null && prev.serving !== undefined) {
        s.game.servePlayed++;
        if (winner === prev.serving) s.game.serveWon++;
      }
      s.points[0] += s.game.points[0];
      s.points[1] += s.game.points[1];
      s.servePlayed += s.game.servePlayed;
      s.serveWon += s.game.serveWon;
      s.gamesCounted++;
    } else {
      s.gamesUnreliable++;
      s.unreliableSeen += seen;
    }
    s.game = freshSampledGame();
  }
  return s;
}

const freshSampledGame = () => ({ points: [0, 0], servePlayed: 0, serveWon: 0, pendingBP: null, gap: false });

export const freshSampled = () => ({
  points: [0, 0],
  servePlayed: 0,
  serveWon: 0,
  bp: [{ faced: 0, saved: 0 }, { faced: 0, saved: 0 }],
  gamesCounted: 0,
  gamesUnreliable: 0,
  unreliableSeen: 0,
  game: freshSampledGame(),
});

/** Which side won the game that took `prev` sets to `cur` sets. */
function gamesWinner(prev, cur) {
  const pa = (prev || []).reduce((n, x) => n + (x[0] || 0), 0);
  const pb = (prev || []).reduce((n, x) => n + (x[1] || 0), 0);
  const ca = (cur || []).reduce((n, x) => n + (x[0] || 0), 0);
  const cb = (cur || []).reduce((n, x) => n + (x[1] || 0), 0);
  if (ca > pa && cb === pb) return 0;
  if (cb > pb && ca === pa) return 1;
  return null;
}

const inTiebreak = (sets) => {
  const s = (sets || [])[(sets || []).length - 1];
  return !!s && s[0] === 6 && s[1] === 6;
};

// ---------------------------------------------------------------------------
// changeover detection
// ---------------------------------------------------------------------------

export const TRIGGER = Object.freeze({
  CHANGEOVER: "changeover",   // odd game in a set — sit-down
  SET_BREAK: "set-break",     // between sets — the long one
  TIEBREAK: "tiebreak",       // every 6 points in a tiebreak — a quick swap
});

// How long play is actually stopped, in seconds. A card must be gone before the
// window closes: nothing may still be on screen when the next point starts.
export const WINDOW = Object.freeze({
  [TRIGGER.CHANGEOVER]: 75,
  [TRIGGER.SET_BREAK]: 105,
  [TRIGGER.TIEBREAK]: 25,
});

/**
 * Decide whether the transition from `prev` to `obs` opened a changeover.
 *
 * In a normal set the sides change when the total games played becomes odd, but
 * there is no sit-down after the first game of a set, so the card only fires from
 * the third game on. A completed set is its own (longer) break. In a tiebreak the
 * sides change every 6 points.
 */
export function detectTrigger(prev, obs) {
  if (!prev || obs.status !== "live") return null;
  const sets = obs.sets || [], was = prev.sets || [];
  const si = sets.length - 1;
  if (si < 0) return null;

  // A new set exists -> the set break is on (or was missed while it started).
  if (sets.length > was.length) {
    return { kind: TRIGGER.SET_BREAK, key: `set:${sets.length - 1}`, setIndex: sets.length - 1 };
  }

  const cur = sets[si] || [0, 0], old = was[si] || [0, 0];
  const total = (cur[0] || 0) + (cur[1] || 0);
  const before = (old[0] || 0) + (old[1] || 0);

  if (total > before) {
    // The set just finished — hold the (longer) set break rather than the
    // odd-game one, even though the new set has not appeared in the feed yet.
    if (setComplete(cur[0], cur[1])) {
      return { kind: TRIGGER.SET_BREAK, key: `set:${si}:end`, setIndex: si };
    }
    if (total % 2 === 1 && total >= 3) {
      return { kind: TRIGGER.CHANGEOVER, key: `g:${si}:${total}`, setIndex: si, games: total };
    }
    return null;
  }

  // Tiebreak: sides change every 6 points, so trigger as each multiple is passed.
  if (cur[0] === 6 && cur[1] === 6 && obs.points && prev.points) {
    const now = (parseInt(obs.points[0], 10) || 0) + (parseInt(obs.points[1], 10) || 0);
    const then = (parseInt(prev.points[0], 10) || 0) + (parseInt(prev.points[1], 10) || 0);
    if (now > then && Math.floor(now / 6) > Math.floor(then / 6) && now >= 6) {
      return { kind: TRIGGER.TIEBREAK, key: `tb:${si}:${Math.floor(now / 6)}`, setIndex: si, points: now };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// match state — one object per followed match, mirrored to localStorage
// ---------------------------------------------------------------------------

export function createState(matchId) {
  return {
    matchId,
    v: 1,
    prev: null,
    sampled: freshSampled(),
    // Wall-clock timing the feed does not publish: when each cumulative game was
    // first seen, so game durations can be reported for games we actually watched.
    gameSeenAt: {},
    gameEndedAt: {},
    firstSeenAt: null,
    firedKeys: [],
  };
}

/**
 * Fold one observation into the state.
 * Returns { trigger, stats } — `trigger` is non-null exactly once per changeover.
 */
export function ingest(state, obs) {
  const prev = state.prev;
  if (state.firstSeenAt === null) state.firstSeenAt = obs.at;

  // game clock: index games cumulatively so a set boundary does not reset them
  const played = (obs.sets || []).reduce((n, s) => n + (s[0] || 0) + (s[1] || 0), 0);
  if (state.gameSeenAt[played] === undefined) state.gameSeenAt[played] = obs.at;
  if (prev) {
    const before = (prev.sets || []).reduce((n, s) => n + (s[0] || 0) + (s[1] || 0), 0);
    if (played > before) state.gameEndedAt[before] = obs.at;
  }

  if (!obs.log) state.sampled = sampleStep(state.sampled, prev, obs);

  let trigger = detectTrigger(prev, obs);
  // Fire once per changeover: a repeated poll of the same state must not relaunch
  // a card that is already running (or already finished).
  if (trigger) {
    if (state.firedKeys.includes(trigger.key)) trigger = null;
    else {
      state.firedKeys.push(trigger.key);
      if (state.firedKeys.length > 40) state.firedKeys.shift();
      trigger.at = obs.at;
    }
  }

  state.prev = obs;
  return { trigger, stats: summarize(state, obs) };
}

/** Everything the renderer can draw, tier by tier. */
export function summarize(state, obs) {
  const exact = obs.log ? exactFromLog(obs.log) : null;
  const durations = [];
  if (obs.setDurations) {
    for (let i = 1; i <= 5; i++) {
      const v = obs.setDurations[`set${i}`];
      if (v) durations.push({ set: i, text: v, minutes: hhmmToMin(v) });
    }
  }
  // Game durations are wall-clock observations, never published by either feed —
  // only games this overlay was running for have one.
  const gameDurations = [];
  for (const k of Object.keys(state.gameEndedAt)) {
    const start = state.gameSeenAt[k];
    const end = state.gameEndedAt[k];
    if (start && end && end > start) gameDurations.push({ index: +k, seconds: Math.round((end - start) / 1000) });
  }
  gameDurations.sort((a, b) => a.index - b.index);

  return {
    matchId: state.matchId,
    status: obs.status,
    teams: obs.teams,
    sets: obs.sets,
    points: obs.points,
    serving: obs.serving ?? null,
    exact,
    sampled: obs.log ? null : state.sampled,
    durations,
    longestGame: gameDurations.reduce((m, g) => (!m || g.seconds > m.seconds ? g : m), null),
    gameDurations,
    watchedFrom: state.firstSeenAt,
  };
}

const hhmmToMin = (v) => {
  const m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
};

// ---------------------------------------------------------------------------
// persistence — an OBS source reload must not reset a match mid-broadcast
// ---------------------------------------------------------------------------

export const STORAGE_PREFIX = "dpk-stats-overlay:";

export function saveState(state, storage) {
  if (!storage) return;
  try {
    storage.setItem(
      STORAGE_PREFIX + state.matchId,
      JSON.stringify({ ...state, prev: null })   // the feed re-supplies `prev` on the next poll
    );
  } catch { /* quota or private mode — the overlay still works, it just forgets */ }
}

export function loadState(matchId, storage) {
  if (!storage) return createState(matchId);
  try {
    const raw = storage.getItem(STORAGE_PREFIX + matchId);
    if (!raw) return createState(matchId);
    const o = JSON.parse(raw);
    if (!o || o.v !== 1 || o.matchId !== matchId) return createState(matchId);
    return { ...createState(matchId), ...o, prev: null };
  } catch {
    return createState(matchId);
  }
}
