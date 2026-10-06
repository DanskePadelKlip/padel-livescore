# Keep PadelTicker's D1 match tables current, nightly: read what D1 holds, export
# only the tournaments it is missing or holds partially, apply that.
#
# Why: export_d1.py's full export renumbers every match and is ~600k rows, far
# past the 100k/day free tier, so it only ever ran by hand - and D1's matches
# stopped at the last full load (found 2026-10-01: nothing after 2026-08-28, so
# Coello's Jul-Sep events and Sebber's Aug-Sep ones were on padel.db and not on
# padelticker.com).
#
# Order of work, all in this one script so the state can never be stale:
#   1. ask D1 for {tkey: match count}, MAX(id) and its player ids
#   2. export_d1.py --delta <that state>  -> d1/matches_delta.sql
#   3. refuse a delta bigger than -MaxStatements (a lost D1, a renumbering
#      full reload half-applied, ...) - that needs a person, not a nightly
#   4. apply it
# The state is read from D1 itself each night, never from a file of what was
# exported last time, so a missed or failed night heals on the next run.
#
# Not covered, by design: OLD rows whose player_id moved because
# fip_player_links or the FIP canon map changed. Those still need a full reload.
#
# Auth: the git-ignored deploy.config.ps1 deploy.ps1 uses, dot-sourced so the
# token never appears on a command line.
#
# Budget: scripts\d1-budget.ps1 is asked twice - before step 1 (the state reads
# are ~100k rows, and on 2026-10-01 they are what failed once the account was
# over its cap) and before step 4 with the real statement count. A deferral
# exits 0 and the next night heals it, since the state is re-read from D1.
#
# Exit codes: 0 = applied, nothing to do, or deferred by the budget guard;
# 2 = refused (too big); 4 = deferred 3 nights running; other = failed.
# -DryRun: steps 1-3 only (reads D1, writes the delta file, applies nothing).
param([int]$MaxStatements = 25000, [switch]$DryRun)
$ErrorActionPreference = "Stop"

# From this script's location, never %USERPROFILE%: a remoting session lands as
# svc-remote, whose profile has no repo in it.
$root   = $PSScriptRoot
$padeldb = Join-Path $root "..\padel-db"
$py     = Join-Path $padeldb ".venv\Scripts\python.exe"
$state  = Join-Path $root "d1\matches_d1_state.json"
$delta  = Join-Path $root "d1\matches_delta.sql"

$cfg = Join-Path $root "..\danskepadelklip-site\deploy.config.ps1"
if (-not (Test-Path $cfg)) { Write-Host "matches delta: missing $cfg"; exit 1 }
. $cfg
if (-not $env:CLOUDFLARE_API_TOKEN) { Write-Host "matches delta: no token in config."; exit 1 }
Set-Location $root
. (Join-Path $root "scripts\d1-budget.ps1")
$gate = Test-D1Budget -Label "matches delta" -Statements 0 -ExtraReads 150000
if (-not $gate.Go) { exit $gate.ExitCode }

function D1Query([string]$sql) {
  # --json prints [{results:[...], success, meta}]; anything else is a failure.
  # Through cmd so wrangler's stderr is dropped there: in PS 5.1 a native stderr
  # line under ErrorActionPreference=Stop is a terminating error even on success.
  # Into a FILE, read back as UTF-8: capturing native stdout decodes it with the
  # console code page, which mangled every non-ASCII player id (fip-a-abruña-...)
  # so 1,132 players D1 has looked missing. The SQL never contains a double quote.
  $tmp = Join-Path $root "d1\d1_query.json"
  cmd /c "npx wrangler d1 execute padelticker-history --remote --json --command `"$sql`" > `"$tmp`" 2>nul"
  if ($LASTEXITCODE -ne 0) { throw "wrangler query failed ($LASTEXITCODE): $sql" }
  $doc = [IO.File]::ReadAllText($tmp, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if (-not $doc[0].success) { throw "D1 query unsuccessful: $sql" }
  return $doc[0].results
}

# ---- 1. what D1 holds right now ----
Write-Host "matches delta: reading D1 state..."
$tk = @{}
foreach ($r in (D1Query "SELECT tkey, COUNT(*) AS n FROM matches GROUP BY tkey")) { $tk[$r.tkey] = [int]$r.n }
$maxId = [int]((D1Query "SELECT COALESCE(MAX(id),0) AS m FROM matches")[0].m)
$players = @(D1Query "SELECT id FROM players" | ForEach-Object { $_.id })
if ($tk.Count -eq 0 -or $players.Count -eq 0) {
  # An empty answer means a wrong database or a reload in flight, not "load everything".
  Write-Host "matches delta: D1 reports $($tk.Count) tournaments / $($players.Count) players - refusing."
  exit 2
}
$doc = [ordered]@{ maxId = $maxId; tkeys = $tk; players = $players }
[IO.File]::WriteAllText($state, ($doc | ConvertTo-Json -Depth 3 -Compress), (New-Object Text.UTF8Encoding $false))
Write-Host "matches delta: D1 has $($tk.Count) tournaments, $($players.Count) players, max id $maxId"

# ---- 2. export ----
$env:PADEL_DB = Join-Path $padeldb "padel.db"
$env:PADEL_D1_OUT = Join-Path $root "d1"
# players-lite.json (the search index) goes to a holding folder, and into public/
# only after D1 has the rows behind it: public/ ships on the refresh daemon's next
# cycle, and an index listing players D1 lacks is search results that 404.
$pending = Join-Path $root "d1\lite_pending"
$env:PADEL_PLAYERS_LITE_OUT = $pending
$env:PYTHONIOENCODING = "utf-8"
if (Test-Path $delta) { Remove-Item -LiteralPath $delta }   # a failed export must not leave last night's file
Push-Location $padeldb
& $py export_d1.py --delta $state
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0 -or -not (Test-Path $delta)) { Write-Host "matches delta: export FAILED ($code)"; exit 1 }

# ---- 3. size guard ----
$lite = Join-Path $root "public\data\players-lite.json"
function PublishLite {
  Move-Item -LiteralPath (Join-Path $pending "players-lite.json") -Destination $lite -Force
  Write-Host "matches delta: players-lite.json updated"
}
$lines = @(Get-Content $delta | Where-Object { $_.Trim() })
if ($lines.Count -eq 0) {
  if (-not $DryRun) { PublishLite }   # match counts can move without new matches for D1
  Write-Host "matches delta: D1 is current - nothing to load."; exit 0
}
if ($lines.Count -gt $MaxStatements) {
  Write-Host "matches delta: $($lines.Count) statements is over the $MaxStatements cap (~3 D1 row-writes each) - refusing. Run with -MaxStatements N to override."
  exit 2
}

if ($DryRun) { Write-Host "matches delta: DRY RUN - $($lines.Count) statement(s) in $delta, nothing applied."; exit 0 }

# ---- 4. apply ----
$gate = Test-D1Budget -Label "matches delta" -Statements $lines.Count
if (-not $gate.Go) { exit $gate.ExitCode }
Write-Host "matches delta: applying $($lines.Count) statement(s) to D1..."
& npx wrangler d1 execute padelticker-history --remote --file d1/matches_delta.sql --yes
if ($LASTEXITCODE -ne 0) { Write-Host "matches delta: FAILED ($LASTEXITCODE)"; exit $LASTEXITCODE }
Write-Host "matches delta: applied $($lines.Count) statement(s)."
# The relink re-keys fip_link.py queued went out at the head of this delta.
$relink = Join-Path $root "d1\relink_pending.sql"
if (Test-Path $relink) { Remove-Item -LiteralPath $relink; Write-Host "matches delta: relink queue applied and cleared" }
PublishLite
