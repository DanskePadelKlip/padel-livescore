// Self-maintaining refresh for the curated pro calendar (public/data/calendar.json).
// Source: the Wikipedia "Premier Padel <year>" schedule table — plain server-
// rendered HTML (no JS), columns Tournament | City | Country | Date. Parsed here
// into the calendar.json shape the app's Upcoming timeline reads. Guarded: if the
// parse yields fewer than MIN_EVENTS it throws WITHOUT writing, so a page/structure
// change can never wipe the calendar to garbage — the last good file just stays.
//
// The daemon calls this weekly (scripts/refresh-loop.js). No new scheduling infra,
// no cloud credentials, no browser — one HTTP GET + a table parse.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MIN_EVENTS = 5;

const MON = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Country name (as Wikipedia writes it) -> ISO 3166-1 alpha-2, for the row flag.
const COUNTRY2 = {
  "saudi arabia": "SA", spain: "ES", mexico: "MX", "united states": "US", qatar: "QA",
  "south africa": "ZA", "united kingdom": "GB", england: "GB", france: "FR",
  netherlands: "NL", germany: "DE", italy: "IT", kuwait: "KW",
  "united arab emirates": "AE", chile: "CL", argentina: "AR", brazil: "BR",
  portugal: "PT", belgium: "BE", sweden: "SE", norway: "NO", denmark: "DK",
  finland: "FI", egypt: "EG", china: "CN", japan: "JP", australia: "AU",
  canada: "CA", switzerland: "CH", austria: "AT", poland: "PL",
  paraguay: "PY", uruguay: "UY", colombia: "CO", peru: "PE", ecuador: "EC",
};

const category = (name) => {
  const n = (name || "").toUpperCase();
  if (/MAJOR/.test(n)) return "Major";
  if (/FINALS?/.test(n)) return "Finals";
  if (/\bP1\b/.test(n)) return "P1";
  if (/\bP2\b/.test(n)) return "P2";
  return "P1";
};

const clean = (s) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\[\s*\d+\s*\]/g, "").replace(/\s+/g, " ").trim();

// "7 February – 14 February" | "31 August – 6 September" | "Postponed" -> {start,end} ISO
function parseRange(str, year) {
  if (/postpone|cancel|tb[ac]|\?/i.test(str)) return null;
  const one = (s) => { const m = s.match(/(\d{1,2})\s+([A-Za-z]+)/); return m && MON[m[2].toLowerCase()] ? { d: +m[1], mo: MON[m[2].toLowerCase()] } : null; };
  const parts = str.split(/[–—-]/).map((s) => s.trim()).filter(Boolean);
  const a = one(parts[0]);
  const b = parts[1] ? one(parts[1]) : a;
  if (!a || !b) return null;
  const endYear = b.mo < a.mo ? year + 1 : year; // Dec–Jan wrap
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { start: iso(year, a.mo, a.d), end: iso(endYear, b.mo, b.d) };
}

export function parsePremierCalendar(html, year) {
  const tables = html.match(/<table[^>]*wikitable[^>]*>[\s\S]*?<\/table>/g) || [];
  const cal = tables.find((t) => /Tournament/i.test(t) && /Country/i.test(t) && /Date/i.test(t));
  if (!cal) throw new Error("Premier calendar table not found on the page");
  const events = [];
  for (const row of cal.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(clean);
    if (cells.length < 4) continue;
    const [name, city, country, dateStr] = cells;
    if (/^tournament$/i.test(name) || !name) continue; // header row
    const range = parseRange(dateStr, year);
    if (!range) continue;
    events.push({ ...range, name, city, country: COUNTRY2[(country || "").toLowerCase()] || "", tour: "Premier Padel", category: category(name) });
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}

// Fetch + parse + write calendar.json. Returns the event count. Throws (without
// writing) if the source can't be parsed into at least MIN_EVENTS events.
export async function refreshCalendar(root, { year = new Date().getFullYear(), today = new Date().toISOString().slice(0, 10) } = {}) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/html/Premier_Padel_${year}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (PadelTicker calendar refresh)" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Wikipedia fetch ${res.status}`);
  const events = parsePremierCalendar(await res.text(), year);
  if (events.length < MIN_EVENTS) throw new Error(`only ${events.length} events parsed — refusing to overwrite calendar.json`);
  const out = join(root, "public", "data", "calendar.json");
  writeFileSync(out, JSON.stringify({
    generatedAt: today,
    source: `Wikipedia Premier_Padel_${year} (auto-refreshed weekly)`,
    events,
  }, null, 2) + "\n");
  return events.length;
}
