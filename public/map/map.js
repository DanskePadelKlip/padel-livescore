// /map - every tournament in the live feed on a world map, with a country index and a
// per-country view sorted by level. Data: /data/map.json (src/map-feed.js), rebuilt by
// the producers each cycle. World outline: Natural Earth 1:50m via world-atlas.
(() => {
  const BANDS = [[0, "Premier Padel"], [35, "FIP"], [100, "National top level"], [120, "National ranked"], [160, "Leagues"], [200, "Club and local"]];
  const bandOf = (r) => BANDS.filter(([min]) => r >= min).pop()[1];
  const SRC = { rankedin: "RankedIn", "rankedin-teamleague": "RankedIn", fip: "FIP", puntuate: "FIP", tournamentsoftware: "tournamentsoftware" };
  const STATE_RANK = { live: 0, today: 1, later: 2, done: 3 };
  const regionName = (() => {
    try { const d = new Intl.DisplayNames(["en"], { type: "region" }); return (c) => { try { return d.of(c) || c; } catch { return c; } }; }
    catch { return (c) => c; }
  })();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const byLevel = (a, b) => a.rank - b.rank || STATE_RANK[a.state] - STATE_RANK[b.state] || b.total - a.total;
  const fmtT = (d, tz) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });

  let DATA = null, ev = [], unplaced = 0;
  let filter = "today", sel = null, country = null;
  const passes = (e) => filter === "all" ? true : filter === "live" ? e.state === "live" : e.state === "live" || e.state === "today";
  const visible = () => ev.filter(passes);

  // ---- map ----
  const narrow = matchMedia("(max-width: 900px)").matches;
  const svg = d3.select("#map"), W = 1000, H = 1000 / (narrow ? 1.35 : 1.75);
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  const g = svg.append("g");
  const landG = g.append("g"), dotsG = g.append("g");
  let land = null, proj = null, path = null, lands = null;
  const featOf = {}, ccOfFeat = {};
  let k = 1;
  const rOf = (e) => 2.6 + Math.sqrt(e.total) * 0.42;
  const scaleR = (r) => r / Math.pow(k, 0.85); // dots stay near one screen size when zoomed
  const zoom = d3.zoom().scaleExtent([1, 60]).translateExtent([[0, 0], [W, H]]).on("zoom", ({ transform }) => {
    k = transform.k; g.attr("transform", transform); g.style("--sw", (0.6 / k).toFixed(4));
    dotsG.selectAll("circle").attr("r", function () { return scaleR(+this.dataset.r); });
  });
  svg.call(zoom).on("dblclick.zoom", null);

  const tip = document.getElementById("tip"), mapcol = document.getElementById("mapcol");
  function tipText(title, line, evt, extra = []) {
    const r = mapcol.getBoundingClientRect();
    tip.replaceChildren(el("b", null, title), el("span", null, line), ...extra);
    tip.style.left = Math.max(0, Math.min(evt.clientX - r.left, r.width - 290)) + "px";
    tip.style.top = (evt.clientY - r.top) + "px";
    tip.hidden = false;
  }
  const showTip = (e, evt) => tipText(e.name, `${e.level} · ${e.place || regionName(e.cc)} · ${e.final} of ${e.total} played${e.state === "live" ? " · LIVE" : ""}`, evt);

  // ---- halls: a team league's ties, one dot per hall with a tie today ----
  // "4-2" once played, the start time before; LIVE ties lead with the running tally.
  const tieLine = (t) => `${t.st === "upcoming" || !t.s ? (t.t || "").padEnd(5) : t.s.padEnd(5)} ${t.a} v ${t.b}${t.st === "live" ? " · LIVE" : ""}`;
  // One hall can host both leagues' ties on the same day (Lunar Ligaen and 4P): one dot
  // per hall, its tip grouped by league.
  const showHallTip = (s, evt) => tipText(s.name, `${plural(s.n, "tie", "ties")} today${s.state === "live" ? " · LIVE" : ""}`, evt,
    s.halls.flatMap((h) => [...(s.halls.length > 1 ? [el("span", "lg", h.ev.name)] : []), ...h.ties.map((t) => el("span", `ln${t.st === "live" ? " live" : ""}`, tieLine(t)))]));
  const rOfHall = (s) => 2.6 + Math.sqrt(s.n * 6) * 0.42; // a tie is ~6 rubbers: same scale as events
  const hallsOn = (e) => e.halls.filter((h) => filter !== "live" || h.state === "live");
  const spotsOf = (halls) => d3.groups(halls, (h) => h.name).map(([name, hs]) => ({
    k: name, name, halls: hs, lat: hs[0].lat, lng: hs[0].lng, prec: hs[0].prec, cc: hs[0].ev.cc,
    n: d3.sum(hs, (h) => h.ties.length), state: hs.some((h) => h.state === "live") ? "live" : "today",
    ek: new Set(hs.map((h) => h.ev.k)),
  }));
  let litHall = null;

  function zoomBox([[x0, y0], [x1, y1]], maxK = 60) {
    const s = Math.min(maxK, 0.85 / Math.max((x1 - x0) / W, (y1 - y0) / H, 1e-3));
    svg.transition().duration(650).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(Math.max(1, s)).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
  }
  const REG = { world: null, europe: [[-11, 35], [32, 63]], nordics: [[4.5, 54.4], [26, 63.5]] };
  function zoomTo(bounds) {
    if (!bounds) { svg.transition().duration(650).call(zoom.transform, d3.zoomIdentity); return; }
    const a = proj(bounds[0]), b = proj(bounds[1]);
    zoomBox([[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]]);
  }
  const boxOf = (pts) => [[d3.min(pts, (p) => p[0]), d3.min(pts, (p) => p[1])], [d3.max(pts, (p) => p[0]), d3.max(pts, (p) => p[1])]];
  function zoomToPoints(pts) {
    const [[x0, y0], [x1, y1]] = boxOf(pts), pad = Math.max(6, (x1 - x0) * 0.15, (y1 - y0) * 0.15);
    zoomBox([[x0 - pad, y0 - pad], [x1 + pad, y1 + pad]], 24);
  }
  function zoomToCountry(cc) { // frame the events, not the territory (Norway has Svalbard)
    const pts = ev.filter((e) => e.cc === cc).flatMap((e) => (e.halls.length ? e.halls : [e]).map((x) => proj([x.lng, x.lat])));
    if (!pts.length) return;
    let [[x0, y0], [x1, y1]] = boxOf(pts);
    const f = featOf[cc];
    if (f) {
      const [[fx0, fy0], [fx1, fy1]] = path.bounds(f);
      if ((fx1 - fx0) * (fy1 - fy0) < 4000) [[x0, y0], [x1, y1]] = [[Math.min(x0, fx0), Math.min(y0, fy0)], [Math.max(x1, fx1), Math.max(y1, fy1)]];
    }
    const pad = Math.max(6, (x1 - x0) * 0.15, (y1 - y0) * 0.15);
    zoomBox([[x0 - pad, y0 - pad], [x1 + pad, y1 + pad]], 24);
  }
  function zoomToEvent(e) {
    const [x, y] = proj([e.lng, e.lat]), s = Math.max(k, e.prec === "country" ? 5 : 9);
    svg.transition().duration(650).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(s).translate(-x, -y));
  }
  document.getElementById("zin").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1.8);
  document.getElementById("zout").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.8);

  function linkCountries() { // the topojson has numeric ids only: learn each feature from the events in it
    for (const id in ccOfFeat) delete ccOfFeat[id];
    ev.forEach((e) => {
      const f = land.features.find((f) => d3.geoContains(f, [e.lng, e.lat]));
      if (f) { ccOfFeat[f.id] ??= e.cc; featOf[e.cc] ??= f; }
    });
    lands.classed("on", (f) => f.id in ccOfFeat);
  }

  function drawDots() {
    // A league with its halls placed is drawn as those halls, not as one dot on the country
    const v = visible().filter((e) => !e.halls.length).sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || b.total - a.total); // live on top
    const hv = spotsOf(visible().flatMap(hallsOn)).sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || b.n - a.n);
    dotsG.selectAll("*").remove();
    for (const e of [...v, ...hv].filter((e) => e.state === "live")) {
      const [x, y] = proj([e.lng, e.lat]), r = e.halls && e.ek ? rOfHall(e) : rOf(e);
      dotsG.append("circle").attr("class", "pulse").attr("cx", x).attr("cy", y).attr("data-r", r).attr("r", scaleR(r));
    }
    dotsG.selectAll("circle.hall").data(hv, (s) => s.k).join("circle")
      .attr("class", (s) => `dot hall ${s.state}${s.prec === "town" ? " approx" : ""}${s.ek.has(sel) ? " sel" : ""}${country && s.cc !== country ? " dim" : ""}`)
      .attr("cx", (s) => proj([s.lng, s.lat])[0]).attr("cy", (s) => proj([s.lng, s.lat])[1])
      .attr("data-r", rOfHall).attr("r", (s) => scaleR(rOfHall(s)))
      .on("mousemove", (evt, s) => showHallTip(s, evt)).on("mouseleave", () => (tip.hidden = true))
      .on("click", (evt, s) => {
        evt.stopPropagation();
        // the league with a live tie here first; a second click moves to the other league
        const hs = s.halls.slice().sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
        const i = hs.findIndex((h) => h.ev.k === sel), h = hs[(i + 1) % hs.length];
        litHall = h.k;
        if (country !== s.cc) openCountry(s.cc, false);
        select(h.ev.k, true); showHallTip(s, evt);
      });
    dotsG.selectAll("circle.ev").data(v, (e) => e.k).join("circle")
      .attr("class", (e) => `dot ev ${e.state}${e.prec === "country" ? " approx" : ""}${sel === e.k ? " sel" : ""}${country && e.cc !== country ? " dim" : ""}`)
      .attr("cx", (e) => proj([e.lng, e.lat])[0]).attr("cy", (e) => proj([e.lng, e.lat])[1])
      .attr("data-r", rOf).attr("r", (e) => scaleR(rOf(e)))
      .on("mousemove", (evt, e) => showTip(e, evt)).on("mouseleave", () => (tip.hidden = true))
      .on("click", (evt, e) => { evt.stopPropagation(); litHall = null; if (country !== e.cc) openCountry(e.cc, false); select(e.k, true); showTip(e, evt); });
    lands.classed("pick", (f) => country != null && ccOfFeat[f.id] === country);
  }

  // ---- list ----
  const list = document.getElementById("list");
  function drawCountries() {
    const v = visible();
    if (!v.length) {
      list.append(el("div", "empty", filter === "live" ? "No court in the feed is live right now. Switch to Today to see where play happened." : "Nothing in the feed is being played today. Switch to All events."));
      return;
    }
    const rows = d3.groups(v, (e) => e.cc).map(([cc, es]) => ({
      cc, es, top: ev.filter((e) => e.cc === cc).sort(byLevel)[0],
      live: es.some((e) => e.state === "live"), today: d3.sum(es, (e) => e.tfinal),
    })).sort((a, b) => a.top.rank - b.top.rank || b.es.length - a.es.length);
    const head = el("div", "grp"); head.append(el("b", null, "Countries"), el("span", null, "by highest level"));
    list.append(head);
    for (const r of rows) {
      const row = el("div", "row crow"); row.tabIndex = 0; row.dataset.cc = r.cc;
      const st = r.live ? "live" : r.es.some((e) => e.state === "today") ? "today" : r.es.some((e) => e.state === "later") ? "later" : "done";
      row.append(el("i", `k ${st}`), el("div", "nm", regionName(r.cc)));
      const num = el("div", "num", plural(r.es.length, "event", "events")); num.append(el("small", null, r.today ? `${r.today} played today` : " "));
      const meta = el("div", "meta"); meta.append(el("span", "tag", r.top.level), " " + r.top.name);
      row.append(num, meta);
      row.onclick = () => openCountry(r.cc);
      row.onkeydown = (kev) => { if (kev.key === "Enter" || kev.key === " ") { kev.preventDefault(); openCountry(r.cc); } };
      list.append(row);
    }
  }

  function eventRow(e) {
    const row = el("div", "row" + (sel === e.k ? " sel" : "")); row.tabIndex = 0; row.dataset.k = e.k;
    row.append(el("i", `k ${e.state}${e.prec === "country" ? " approx" : ""}`), el("div", "nm", e.name));
    const num = el("div", "num", `${e.final}/${e.total}`); num.append(el("small", null, "played")); row.append(num);
    const meta = el("div", "meta"); meta.append(el("span", "tag", e.level));
    const where = e.hallsAll.length ? plural(e.hallsAll.length, "hall today", "halls today") : e.venue || e.place || regionName(e.cc);
    meta.append(" " + [where, e.courts ? `${e.courts} courts` : null, e.tn ? `${e.tfinal}/${e.tn} today` : null].filter(Boolean).join(" · "));
    if (e.url) {
      const a = el("a", null, SRC[e.src] || e.src); a.href = e.url; a.target = "_blank"; a.rel = "noopener";
      a.addEventListener("click", (x) => x.stopPropagation());
      meta.append(" · ", a);
    }
    row.append(meta);
    const prog = el("div", "prog"), bar = el("i", e.state === "live" ? "live" : null);
    bar.style.width = (e.total ? Math.round((100 * e.final) / e.total) : 0) + "%"; prog.append(bar); row.append(prog);
    if (sel === e.k && e.hallsAll.length) { // the selected league opens out into its halls and their ties
      const box = el("div", "halls");
      for (const h of e.hallsAll) {
        const hd = el("div", "h" + (litHall === h.k ? " lit" : "")); hd.dataset.h = h.k;
        const b = el("b"); b.append(el("i", `k ${h.state}${h.lat == null ? " approx" : ""}`), h.name); hd.append(b);
        for (const t of h.ties) {
          const line = el("div", "t" + (t.st === "live" ? " live" : ""));
          line.append(el("span", null, t.st === "upcoming" || !t.s ? t.t || "" : t.s), el("span", null, `${t.a} v ${t.b}${t.st === "live" ? " · LIVE" : ""}`));
          hd.append(line);
        }
        if (h.lat != null) hd.onclick = (x) => { x.stopPropagation(); litHall = h.k; zoomToEvent(h); drawList(); };
        box.append(hd);
      }
      row.append(box);
    }
    row.onclick = () => select(e.k, false);
    row.onkeydown = (kev) => { if (kev.key === "Enter" || kev.key === " ") { kev.preventDefault(); select(e.k, false); } };
    return row;
  }

  function drawCountry(cc) {
    const all = ev.filter((e) => e.cc === cc).sort(byLevel), v = all.filter(passes);
    const top = el("div", "chead");
    const back = el("button", "back", "← All countries"); back.onclick = closeCountry;
    const title = el("div", "ctitle");
    title.append(el("b", null, regionName(cc)), el("span", null, `${plural(all.length, "event", "events")} in the feed · ${d3.sum(all, (e) => e.tfinal)} matches played today`));
    top.append(back, title); list.append(top);
    let lastBand = null;
    for (const e of v) {
      const b = bandOf(e.rank);
      if (b !== lastBand) { const h = el("div", "grp"); h.append(el("b", null, b)); list.append(h); lastBand = b; }
      list.append(eventRow(e));
    }
    if (!v.length) list.append(el("div", "empty", filter === "live" ? `Nothing live in ${regionName(cc)} right now.` : `No event in ${regionName(cc)} is playing today.`));
    const hidden = all.length - v.length;
    if (hidden) { const more = el("button", "more", `Show ${plural(hidden, "more event", "more events")}`); more.onclick = () => setFilter("all"); list.append(more); }
  }

  function drawList() { const top = list.scrollTop; list.replaceChildren(); country ? drawCountry(country) : drawCountries(); list.scrollTop = top; }

  function setHeadline() {
    const h = document.getElementById("headline"), s = document.getElementById("sub");
    const liveN = ev.filter((e) => e.state === "live").length;
    if (country) {
      const all = ev.filter((e) => e.cc === country), v = all.filter(passes), top = all.slice().sort(byLevel)[0];
      h.textContent = `${regionName(country)}: ${plural(v.length, "event", "events")}${filter === "today" ? " playing today" : filter === "live" ? " live now" : " in the feed"}`;
      s.textContent = top ? `Highest level: ${top.level}` : "";
      return;
    }
    const v = visible(), countries = new Set(v.map((e) => e.cc)).size;
    if (filter === "live") {
      h.textContent = liveN ? `${plural(liveN, "event", "events")} live right now` : "Nothing live right now";
      s.textContent = liveN ? `in ${plural(countries, "country", "countries")}` : "";
    } else if (filter === "today") {
      h.textContent = `${plural(v.length, "event", "events")} playing today in ${plural(countries, "country", "countries")}`;
      s.textContent = `${ev.reduce((n, e) => n + e.tfinal, 0).toLocaleString("en")} matches finished so far, ${liveN ? liveN + " live now" : "none live right now"}`;
    } else {
      h.textContent = `${plural(v.length, "event", "events")} in ${plural(countries, "country", "countries")}`;
      s.textContent = unplaced ? `${unplaced} more could not be placed on the map` : "";
    }
  }

  function render() { setHeadline(); drawDots(); drawList(); }
  function openCountry(cc, zoomIt = true) {
    country = cc; sel = null; tip.hidden = true;
    document.querySelectorAll("[data-r]").forEach((x) => x.setAttribute("aria-pressed", "false"));
    list.scrollTop = 0; render(); if (zoomIt) zoomToCountry(cc);
  }
  function closeCountry() {
    country = null; sel = null; list.scrollTop = 0; render();
    document.querySelectorAll("[data-r]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.r === "world")); zoomTo(null);
  }
  function markSel() {
    dotsG.selectAll("circle.dot").classed("sel", (d) => (d.ek ? d.ek.has(sel) : d.k === sel));
    list.querySelectorAll(".row").forEach((r) => r.classList.toggle("sel", r.dataset.k === sel));
  }
  function select(key, fromMap) {
    const was = sel;
    sel = sel === key && !fromMap ? null : key;
    if (!fromMap) litHall = null;
    // a league row grows (or shrinks) its hall list, so it is rebuilt rather than restyled
    if ([was, sel].some((k) => k && ev.find((x) => x.k === k)?.hallsAll.length)) drawList();
    markSel();
    if (!sel) return;
    const e = ev.find((x) => x.k === sel);
    if (fromMap) {
      if (!passes(e)) setFilter("all");
      const r = list.querySelector(litHall ? `.h[data-h="${CSS.escape(litHall)}"]` : `.row[data-k="${CSS.escape(sel)}"]`)
        || list.querySelector(`.row[data-k="${CSS.escape(sel)}"]`);
      if (r) r.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (e.halls.length) zoomToPoints(e.halls.map((h) => proj([h.lng, h.lat])));
    else zoomToEvent(e);
  }
  function setFilter(f) {
    filter = f; tip.hidden = true;
    document.querySelectorAll("[data-f]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.f === f));
    render(); markSel();
  }
  document.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => setFilter(b.dataset.f)));
  document.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => {
    country = null; sel = null; render();
    document.querySelectorAll("[data-r]").forEach((x) => x.setAttribute("aria-pressed", x === b)); zoomTo(REG[b.dataset.r]);
  }));

  function fitList() { // the list column matches the map's height on wide screens
    list.style.maxHeight = matchMedia("(max-width: 900px)").matches ? "none" : document.getElementById("map").getBoundingClientRect().height + "px";
  }
  new ResizeObserver(fitList).observe(document.getElementById("map"));

  // ---- data ----
  function ingest(data) {
    DATA = data;
    const all = (data.events || []).map((e) => ({
      ...e,
      cc: String(e.cc || "").toUpperCase() || null,
      state: e.live > 0 || e.tlive > 0 ? "live" : e.tn > 0 ? "today" : e.upcoming > 0 ? "later" : "done",
    }));
    for (const e of all) { // a team league's halls (src/map-feed.js hallsOf); every hall listed has a tie today
      e.hallsAll = (e.halls || []).map((h) => ({ ...h, ev: e, k: `${e.k}|${h.name}`, state: h.live > 0 ? "live" : "today" }));
      e.halls = e.hallsAll.filter((h) => h.lat != null);
    }
    ev = all.filter((e) => e.lat != null && e.cc);
    unplaced = all.length - ev.length;
    const gen = new Date(data.generatedAt);
    document.getElementById("stamp").textContent = `Updated ${fmtT(gen, undefined)}`;
    if (country && !ev.some((e) => e.cc === country)) country = null;
    if (sel && !ev.some((e) => e.k === sel)) sel = null;
  }

  let timer = null, first = true;
  async function refresh() {
    clearTimeout(timer);
    try {
      const r = await fetch("/data/map.json?_=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      ingest(await r.json());
      linkCountries(); render(); markSel();
      // On a phone the whole world is a thin strip with Europe's dots in one clump,
      // so open on Europe, where most of the feed is played.
      if (first && narrow) {
        document.querySelectorAll("[data-r]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.r === "europe"));
        zoomTo(REG.europe);
      }
      first = false;
    } catch (e) {
      if (!DATA) list.replaceChildren(el("div", "empty", "The map feed could not be loaded. It refreshes with the live scores; try again in a minute."));
    }
    const live = ev.some((e) => e.state === "live");
    timer = setTimeout(refresh, document.hidden ? 5 * 60_000 : live ? 60_000 : 5 * 60_000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && DATA && Date.now() - Date.parse(DATA.generatedAt) > 90_000) refresh(); });

  fetch("/map/countries-50m.json").then((r) => r.json()).then((world) => {
    land = topojson.feature(world, world.objects.countries);
    land.features = land.features.filter((f) => f.id !== "010"); // no Antarctica
    proj = d3.geoNaturalEarth1().fitExtent([[8, 8], [W - 8, H - 8]], land);
    path = d3.geoPath(proj);
    lands = landG.selectAll("path").data(land.features).join("path").attr("class", "land").attr("d", path)
      .on("click", (evt, f) => { if (f.id in ccOfFeat) openCountry(ccOfFeat[f.id]); })
      .on("mousemove", (evt, f) => {
        if (!(f.id in ccOfFeat)) return;
        const cc = ccOfFeat[f.id];
        tipText(regionName(cc), plural(ev.filter((e) => e.cc === cc).length, "event", "events") + " · click to open", evt);
      })
      .on("mouseleave", () => (tip.hidden = true));
    refresh();
  }).catch(() => list.replaceChildren(el("div", "empty", "The world map could not be loaded.")));
})();
