"""Tell Bing (and every IndexNow engine) which PadelTicker pages really changed.

Runs on the laptop from the padel-db nightly (run_nightly.laptop.cmd), FIRST, so it
reads the files the previous night and the refresh daemon have long since deployed:

    python scripts/indexnow.py            stamp, then ping
    python scripts/indexnow.py --stamp    only record changes and queue them
    python scripts/indexnow.py --ping     only send the queue
    python scripts/indexnow.py --dry      stamp into memory, print, save and send nothing

Modelled on danskepadelklip-site/indexnow.py, with one difference: DPK's pages are
built HTML files it can hash, while PadelTicker's are rendered at request time by
Pages Functions from static data. So each URL is fingerprinted from the data that
renders it, read straight off public/ - never by fetching the page, which would cost a
Function invocation (and for players two D1 queries) per URL:

    /rankings/<fed>/<cat>         the list's top 100 rows (rankings.json, rankings-fip.json)
    /tournament/<src>/<id>        that event's archive file (data/archive/t/<key>.json)
    /national-teams/country/<cc>  that nation's rows (national-teams.json)
    /player/<id>                  the latest 20 matches in the career file (data/pm)
    hubs                          the file behind each (/results, /rankings, ...)

Players are the ids the sitemap lists (functions/sitemap.xml.js): ranked or on the
Elo board, AND with a D1 profile (players-lite.json). Live-feed tournament URLs are
left out: they stop resolving once the event leaves the feed.

A URL is queued the first time it is seen and whenever its fingerprint changes;
state/indexnow.json (gitignored) keeps fingerprints, change dates and the queue. At
most --max URLs go out per run (default 2000, most valuable first: hubs, rankings,
newest tournaments, nations, players), so a big change reaches Bing over several
nights instead of as one crawl burst on the 100k/day Functions cap.

The ping only goes out when the live site carries what was fingerprinted: the key
file must answer with the key, and the live career files must be the local ones
(data/pm/meta.json "generated" equal). Otherwise the queue waits for the next run.
api.indexnow.org answers 403 to the default Python-urllib User-Agent, hence the UA.

Never fails the nightly: every path exits 0 and prints what it did.
"""
import datetime, glob, hashlib, json, os, re, sys, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, "public")
DATA = os.path.join(PUB, "data")
STATE = os.path.join(ROOT, "state", "indexnow.json")
HOST = "padelticker.com"
SITE = "https://" + HOST
KEY = "9e4ac7442dcbe54a382d388ea3ba8c3e"  # served as public/<KEY>.txt
ENDPOINT = "https://api.indexnow.org/indexnow"
UA = "padelticker-indexnow/1.0 (+https://padelticker.com)"
MAX_DEFAULT = 2000


def log(msg):
    print(f"  indexnow    : {msg}", flush=True)


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def fp(value):
    """Fingerprint of a JSON-able value (or of raw text)."""
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:20]


def file_fp(path):
    try:
        with open(path, "rb") as f:
            t = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    return fp(re.sub(r"\s+", " ", t).strip())


def seg(s):
    return urllib.parse.quote(str(s), safe="")


def safe_key(k):
    # export_archive.safe(): the archive file name for a tournament key.
    return re.sub(r"[^a-z0-9_-]", "", k.lower())


def profile_ids():
    lite = load(os.path.join(DATA, "players-lite.json"), {}) or {}
    return {row[0] for row in lite.get("players", []) if row}


def pm_fingerprints(wanted):
    """{id: fingerprint of the latest 20 matches} for the wanted ids, from data/pm."""
    out = {}
    for shard in glob.glob(os.path.join(DATA, "pm", "*.json")):
        if os.path.basename(shard) == "meta.json":
            continue
        d = load(shard, {}) or {}
        for pid, groups in (d.get("p") or {}).items():
            if pid not in wanted:
                continue
            left, shown = 20, []
            for g in groups:
                if left <= 0:
                    break
                rows = (g[3] if len(g) > 3 else [])[:left]
                left -= len(rows)
                shown.append([g[0], g[1], g[2], rows])
            out[pid] = fp([shown, sum(len(g[3]) for g in groups if len(g) > 3)])
    return out


def build():
    """Ordered [(url, fingerprint)], most valuable first."""
    urls = []
    add = lambda path, h: urls.append((SITE + path, h)) if h else None

    # Hubs.
    add("/rules", file_fp(os.path.join(PUB, "rules.html")))
    add("/dictionary", file_fp(os.path.join(PUB, "dictionary.html")))
    archive = load(os.path.join(DATA, "archive", "index.json"), {}) or {}
    tours = archive.get("tournaments") or []
    add("/results", fp(tours) if tours else None)
    nat = load(os.path.join(DATA, "rankings.json"), {}) or {}
    fipr = load(os.path.join(DATA, "rankings-fip.json"), {}) or {}
    lists = [l for l in (fipr.get("lists") or []) + (nat.get("lists") or []) if l.get("fed") and l.get("category")]
    add("/rankings", fp([[l["fed"], l["category"]] for l in lists]) if lists else None)
    teams = load(os.path.join(DATA, "national-teams.json"), {}) or {}
    rows = teams.get("rows") or []
    add("/national-teams", fp(rows) if rows else None)
    earn = file_fp(os.path.join(DATA, "earnings.json"))
    for p in ("/earnings", "/earnings/men", "/earnings/women"):
        add(p, earn)

    # One page per ranking list: what the server-rendered body shows.
    for l in lists:
        add(f"/rankings/{seg(l['fed'])}/{seg(l['category'])}", fp((l.get("rows") or [])[:100]))

    # Archive tournaments, newest first (index.json is sorted by start, descending).
    for t in tours:
        if not t.get("key") or not t.get("source"):
            continue
        key, src = t["key"], t["source"]
        tid = key[len(src) + 1:] if key.startswith(src + "-") else key
        add(f"/tournament/{seg(src)}/{seg(tid)}",
            file_fp(os.path.join(DATA, "archive", "t", safe_key(key) + ".json")))

    # One page per nation.
    by_cc = {}
    for r in rows:
        if r.get("c"):
            by_cc.setdefault(str(r["c"]).lower(), []).append(r)
    for code in sorted(by_cc):
        add(f"/national-teams/country/{seg(code)}", fp(by_cc[code]))

    # Players: the sitemap's set.
    ids = []
    seen = set()
    elo = load(os.path.join(DATA, "rankings-elo.json"), {}) or {}
    for l in lists + (elo.get("lists") or []):
        for r in l.get("rows") or []:
            pid = r.get("id")
            if pid and pid not in seen:
                seen.add(pid)
                ids.append(pid)
    known = profile_ids()
    if known:
        ids = [i for i in ids if i in known]
    pm = pm_fingerprints(set(ids))
    for pid in ids:
        add(f"/player/{seg(pid)}", pm.get(pid, "no-career-file"))
    return urls


def stamp(dry=False):
    st = load(STATE, None) or {"urls": {}, "pending": []}
    urls, pending = st.setdefault("urls", {}), set(st.get("pending", []))
    today = datetime.date.today().isoformat()
    built = build()
    if not built:
        log("no data files found - nothing stamped")
        return st
    changed = new = 0
    for loc, h in built:
        rec = urls.get(loc)
        if rec is None:
            urls[loc] = {"h": h, "d": today}
            pending.add(loc)
            new += 1
        elif rec.get("h") != h:
            rec["h"], rec["d"] = h, today
            pending.add(loc)
            changed += 1
    live = [loc for loc, _ in built]
    live_set = set(live)
    for gone in [u for u in urls if u not in live_set]:
        del urls[gone]
    st["pending"] = [u for u in live if u in pending]  # keep the build's priority order
    kinds = {}
    for u in st["pending"]:
        k = urllib.parse.urlparse(u).path.split("/")[1] or "/"
        kinds[k] = kinds.get(k, 0) + 1
    log(f"{len(live)} urls, {new} new, {changed} changed, {len(st['pending'])} queued {kinds}"
        + (" (dry run, nothing saved)" if dry else ""))
    if not dry:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = STATE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=0, sort_keys=True)
        os.replace(tmp, STATE)
    return st


def get(url):
    req = urllib.request.Request(url + ("&" if "?" in url else "?") + "cb=" + datetime.datetime.now().strftime("%H%M%S%f"),
                                 headers={"User-Agent": UA, "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def deployed():
    """(ok, reason): does the live site carry the key file and the local career files?"""
    try:
        if get(f"{SITE}/{KEY}.txt").strip() != KEY:
            return False, "the key file is not live yet"
    except Exception as e:
        return False, f"the key file is not live yet ({e})"
    local = (load(os.path.join(DATA, "pm", "meta.json"), {}) or {}).get("generated")
    try:
        live = json.loads(get(f"{SITE}/data/pm/meta.json")).get("generated")
    except Exception as e:
        return False, f"live data/pm/meta.json unreadable ({e}) - a GitHub Actions deploy ships without data/pm"
    if local != live:
        return False, f"live career files ({live}) are not the local ones ({local}) yet"
    return True, ""


def ping(st, limit):
    queue = st.get("pending", [])
    if not queue:
        log("nothing to ping")
        return
    ok, why = deployed()
    if not ok:
        log(f"ping held: {why}; {len(queue)} stay queued")
        return
    batch = queue[:limit]
    body = json.dumps({"host": HOST, "key": KEY, "keyLocation": f"{SITE}/{KEY}.txt",
                       "urlList": batch}).encode("utf-8")
    req = urllib.request.Request(ENDPOINT, data=body, method="POST",
                                 headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:
        log(f"ping failed ({e}); {len(queue)} stay queued")
        return
    if code not in (200, 202):
        log(f"ping got HTTP {code}; {len(queue)} stay queued")
        return
    st["pending"] = queue[len(batch):]
    st["last_ping"] = {"at": datetime.datetime.now().isoformat(timespec="seconds"), "sent": len(batch), "http": code}
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=0, sort_keys=True)
    os.replace(tmp, STATE)
    log(f"pinged {len(batch)} urls (HTTP {code}), {len(st['pending'])} still queued")


def main(argv):
    limit = MAX_DEFAULT
    if "--max" in argv:
        limit = int(argv[argv.index("--max") + 1])
    if "--dry" in argv:
        stamp(dry=True)
    elif "--ping" in argv:
        ping(load(STATE, None) or {"pending": []}, limit)
    elif "--stamp" in argv:
        stamp()
    else:
        ping(stamp(), limit)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as e:  # never cost the nightly a step
        log(f"skipped ({e!r})")
    sys.exit(0)
