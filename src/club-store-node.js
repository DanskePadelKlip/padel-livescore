// Node persistence for the RankedIn club cache (src/rankedin-club.js): the same
// git-ignored .cache/ file the cache always lived in, so daemon restarts and
// one-shot scripts/fetch-live.js runs start warm. Kept out of rankedin-club.js
// itself so the Worker bundle (which injects a KV store instead) never pulls in
// node:fs.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), ".cache");
const FILE = join(DIR, "rankedin-clubs.json");

export function fsClubStore() {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(FILE, "utf8"));
      } catch {
        return null;
      }
    },
    save(entries) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify(entries));
    },
  };
}
