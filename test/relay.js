#!/usr/bin/env node
// Contract test for functions/api/live-detail.js.
//
//   node test/relay.js            # param validation only (no network)
//   node test/relay.js --live     # also hits the real upstreams
//
// A Pages Function is just a module exporting onRequestGet(), so it can be called
// directly with a Request. That covers everything except the Cloudflare edge cache
// behaviour, which only a deploy can prove.

import { onRequestGet, onRequestOptions } from "../functions/api/live-detail.js";

const LIVE = process.argv.includes("--live");
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const call = (qs) => onRequestGet({ request: new Request(`https://padelticker.com/api/live-detail?${qs}`) });

console.log("live-detail relay — contract");

console.log("\nparameter validation (no network)");
{
  const none = await call("");
  check("no params is a 400", none.status === 400);
  check("the 400 explains both call shapes", /tid|event/.test(await none.clone().text()));

  check("a non-numeric tid is rejected", (await call("tid=abc&day=29")).status === 400);
  check("a tid without a day is rejected", (await call("tid=397")).status === 400);
  check("day 0 is rejected", (await call("tid=397&day=0")).status === 400);
  check("day 32 is rejected", (await call("tid=397&day=32")).status === 400);
  check("a path-traversal tid is rejected", (await call("tid=397%2F..%2F..&day=29")).status === 400);
  check("a malformed event id is rejected", (await call("event=notanevent")).status === 400);
  check("an event id with a path is rejected", (await call("event=FIP-2026-3507%2Fevil")).status === 400);

  const opt = await onRequestOptions();
  check("OPTIONS preflight answers 204", opt.status === 204);
  check("preflight carries permissive CORS", opt.headers.get("access-control-allow-origin") === "*");
  check("preflight allows GET only", /GET/.test(opt.headers.get("access-control-allow-methods") || "") &&
    !/POST/.test(opt.headers.get("access-control-allow-methods") || ""));

  check("errors still carry CORS (the overlay must be able to read them)",
    none.headers.get("access-control-allow-origin") === "*");
}

if (!LIVE) {
  console.log("\n(skipping upstream checks — re-run with --live to hit sporteaser/crionet)");
} else {
  console.log("\nupstream (real network)");
  const res = await call("tid=397&day=26");
  check("a valid sporteaser request succeeds", res.status === 200, `status ${res.status}`);
  check("it is JSON", (res.headers.get("content-type") || "").includes("application/json"));
  check("CORS is permissive", res.headers.get("access-control-allow-origin") === "*");
  check("it is cacheable for 2 s", res.headers.get("cache-control") === "public, max-age=2");
  const body = await res.json();
  check("the day payload carries matches", Array.isArray(body.matches) && body.matches.length > 0,
    `${body.matches?.length} matches`);
  check("and the tournament's valid play days", Array.isArray(body.days) && body.days.length > 0);
  check("the point log survives the relay untouched",
    body.matches.some((m) => m.pointHistory?.results?.length));

  const id = String(body.matches.find((m) => m.pointHistory?.results?.length).id);
  const one = await call(`tid=397&day=26&match=${id}`);
  const oneBody = await one.json();
  check("the match filter returns exactly that match", oneBody.matches?.length === 1 && String(oneBody.matches[0].id) === id);
  check("the filtered response keeps the days array", Array.isArray(oneBody.days) && oneBody.days.length > 0);
  const full = JSON.stringify(body).length, trimmed = JSON.stringify(oneBody).length;
  check("filtering is what makes a 3 s poll affordable", trimmed < full / 4,
    `${Math.round(full / 1024)} KB -> ${Math.round(trimmed / 1024)} KB`);

  const cri = await call("event=FIP-2026-3507");
  check("the crionet board relays as HTML", cri.status === 200 && (cri.headers.get("content-type") || "").includes("text/html"),
    `status ${cri.status}`);
  const html = await cri.text();
  check("and comes back as real markup, not an upstream 403", /<html|<table|<body/i.test(html),
    `${html.length} bytes`);
  console.log(`  crionet board: ${html.length} bytes, ${(html.match(/scorebox-header-live/g) || []).length} match(es) on court`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(1);
}
