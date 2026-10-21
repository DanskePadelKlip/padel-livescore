// Unit tests for the per-event live files (src/live-tournaments*.js): file keys, the
// grouping, the writer's change/stale handling, and that the route's lookup over one
// file finds exactly the rows it used to find in the whole feed (no network).
import assert from "node:assert/strict";
import { liveTournamentKey, groupLiveTournaments } from "../src/live-tournaments.js";
import { writeLiveTournaments } from "../src/live-tournaments-node.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log("  ok  " + name); };

const row = (source, tid, id, extra = {}) => ({ id, source, tournament: { id: tid, name: `T ${tid}` }, teams: [{}, {}], ...extra });

await ok("keys: source-id, lowercased, plain filename alphabet only", () => {
  assert.equal(liveTournamentKey("rankedin", 74238), "rankedin-74238");
  assert.equal(liveTournamentKey("puntuate", "FIP-2026-3918"), "puntuate-fip-2026-3918");
  assert.equal(liveTournamentKey("rankedin-teamleague", "123"), "rankedin-teamleague-123");
  for (const bad of ["a b", "a/b", "a%2Fb", "..\\x", "a?b", "a#b", "ø"]) assert.equal(liveTournamentKey("fip", bad), null, bad);
  assert.equal(liveTournamentKey("", "1"), null);
});

await ok("grouping keeps feed order, folds case, skips rows with no event", () => {
  const feed = [row("fip", "X-1", "a"), row("rankedin", 7, "b"), row("fip", "x-1", "c"), { id: "d", source: "fip" }, row("fip", "X-1", "e")];
  const { groups, skipped } = groupLiveTournaments(feed);
  assert.equal(skipped, 1);
  assert.deepEqual([...groups.keys()], ["fip-x-1", "rankedin-7"]);
  assert.deepEqual(groups.get("fip-x-1").map((m) => m.id), ["a", "c", "e"]);
});

await ok("the route's filter over one file == its old filter over the whole feed", () => {
  const feed = [row("fip", "X-1", "a"), row("rankedin", 7, "b"), row("fip", "x-1", "c"), row("rankedin", "7", "d"), row("fip", "X-1", "e")];
  const { groups } = groupLiveTournaments(feed);
  const pick = (rows, source, id) => rows.filter((x) => x.source === source && String(x.tournament.id) === String(id)).map((m) => m.id);
  for (const [source, id] of [["fip", "X-1"], ["fip", "x-1"], ["rankedin", "7"], ["fip", "nope"]]) {
    const file = groups.get(liveTournamentKey(source, id)) || [];
    assert.deepEqual(pick(file, source, id), pick(feed, source, id), `${source}/${id}`);
  }
});

await ok("writer: writes, skips unchanged, rewrites changed, drops stale, leaves other files", () => {
  const root = mkdtempSync(join(tmpdir(), "live-t-"));
  try {
    const dir = join(root, "public", "data", "live-t");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fip-gone.json"), "{}"); // left by an earlier run
    writeFileSync(join(dir, "notes.txt"), "keep");
    const feed = [row("fip", "A", "1"), row("rankedin", 2, "2"), row("fip", "A", "3")];

    const index = () => JSON.parse(readFileSync(join(dir, "_index.json"), "utf8"));
    let r = writeLiveTournaments(root, feed);
    assert.deepEqual(r, { events: 2, written: 2, removed: 1, skipped: 0 });
    assert.deepEqual(readdirSync(dir).sort(), ["_index.json", "fip-a.json", "notes.txt", "rankedin-2.json"]);
    const a = JSON.parse(readFileSync(join(dir, "fip-a.json"), "utf8"));
    assert.equal(a.count, 2);
    assert.deepEqual(a.matches, [feed[0], feed[2]]);
    assert.deepEqual(index(), { events: 2, keys: ["fip-a", "rankedin-2"] });

    r = writeLiveTournaments(root, feed);
    assert.equal(r.written, 0, "nothing changed");

    feed[1] = row("rankedin", 2, "2", { status: "final" });
    r = writeLiveTournaments(root, feed);
    assert.equal(r.written, 1, "only the event that moved");
    assert.equal(JSON.parse(readFileSync(join(dir, "rankedin-2.json"), "utf8")).matches[0].status, "final");

    unlinkSync(join(dir, "fip-a.json")); // someone cleaned the folder
    r = writeLiveTournaments(root, feed);
    assert.equal(r.written, 1);
    assert.ok(existsSync(join(dir, "fip-a.json")));

    r = writeLiveTournaments(root, feed.filter((m) => m.source === "fip")); // rankedin left the feed
    assert.equal(r.removed, 1);
    assert.deepEqual(readdirSync(dir).sort(), ["_index.json", "fip-a.json", "notes.txt"]);
    assert.deepEqual(index().keys, ["fip-a"]);

    r = writeLiveTournaments(root, []); // an empty feed still says "this producer writes slices"
    assert.deepEqual(readdirSync(dir).sort(), ["_index.json", "notes.txt"]);
    assert.deepEqual(index(), { events: 0, keys: [] });

    assert.equal(writeLiveTournaments(join(root, "\0bad"), feed), null, "never throws");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${pass} passed`);
