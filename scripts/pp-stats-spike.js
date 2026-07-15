// SPIKE: pull point-level match stats from Premier Padel's match-centre.
// The page is server-rendered (Next.js RSC) so a plain fetch won't do — we
// render it with the same Playwright layer the FIP adapter uses, then parse
// the stats out of the DOM. Usage: node scripts/pp-stats-spike.js <matchId>
import { withPage } from "../src/browser.js";

const id = process.argv[2] || "18126";
const URL = `https://premierpadel.com/en/matchstats/${id}`;

const result = await withPage(async (page) => {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  // stats hydrate a moment after load
  await page.waitForFunction(() => /Total Points Won/i.test(document.body.innerText), { timeout: 25000 }).catch(() => {});

  return await page.evaluate(() => {
    const sec = document.querySelector(".match-centre-stats-section");
    const text = (sec || document.body).innerText;

    const stats = [];
    // percentage stats: "56%\n32/57\nTotal Points Won\n44%\n25/57"
    const rePct = /(\d+)%\s*\n\s*(\d+)\/(\d+)\s*\n\s*([A-Za-z][A-Za-z .%()/'-]+?)\s*\n\s*(\d+)%\s*\n\s*(\d+)\/(\d+)/g;
    let m;
    while ((m = rePct.exec(text)))
      stats.push({ stat: m[4].trim(), home: { pct: +m[1], won: +m[2], of: +m[3] }, away: { pct: +m[5], won: +m[6], of: +m[7] } });
    // count stats (e.g. streaks): "6\nLongest Points Won Streak\n7"
    const reCnt = /(?:^|\n)\s*(\d+)\s*\n\s*([A-Za-z][A-Za-z .%()/'-]*(?:Streak|Games|Aces|Errors|Winners)[A-Za-z .%()/'-]*)\s*\n\s*(\d+)\s*(?:\n|$)/g;
    while ((m = reCnt.exec(text)))
      stats.push({ stat: m[2].trim(), home: { value: +m[1] }, away: { value: +m[3] } });

    // players (STATS header "GIORGIA\nMARCHETTI\n... VS ...") + match header
    const body = document.body.innerText;
    const tour = (body.match(/\n\s*([A-Z][A-Z0-9 .'À-ſ]+?\bP\d\b[^\n]*|[^\n]*(?:MAJOR|FINALS)[^\n]*)\n/) || [])[1] || null;
    const round = (body.match(/COURT[^\n|]*\|\s*([A-Z0-9]+)/) || [])[1] || null;
    const players = [...(body.matchAll(/\n([A-Z][A-Z .'À-ſ]{2,})\((\d+)\)/g))].map((x) => `${x[1].trim()} (#${x[2]})`);

    return { tournament: tour && tour.trim(), round, players: [...new Set(players)].slice(0, 4), stats, tabsPresent: ["MATCH", "SERVICE", "RETURN"].filter((l) => body.includes(l)) };
  });
});

console.log(JSON.stringify({ id, url: URL, ...result }, null, 2));
process.exit(0);
