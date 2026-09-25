# Apply d1/players_link.sql - a players row for every Dane fip_player_links
# currently resolves to whom padel.db's `players` table does not hold - to
# PadelTicker's D1.
#
# WHY THIS RUNS NIGHTLY. export_d1.py emits these rows too, but it is a MANUAL
# full export (D1's players/matches were last loaded 2026-08-28), while
# fip_link.py rebuilds the link table every night from run_nightly. Between two
# full exports a fresh link therefore resolves to a player D1 has no profile
# row for, and that same night's elo and earnings loads write that player a
# rating and a prize-money row onto a page that 404s. On 2026-09-25 that was 40
# people, 32 of them already carrying an Elo nobody could reach.
#
# COST. About 40 rows, INSERT OR REPLACE, 3 D1 row-writes each once the two
# indexes are counted: ~120 of the 100k/day free tier, 0.12%. The exporter is
# deliberately stateless, so this re-sends the same rows every night and a
# missed or half-applied night heals itself.
#
# Refuses a STALE file, like load_earnings_d1.ps1: the nightly runs this right
# after the export, so a file left from an earlier run means the export did not
# run tonight and must not be applied as though it had.
#
# Only the statement COUNT is read here. wrangler reads the file itself, so the
# Danish names never pass through PowerShell's ANSI codepage.
#
# Auth comes from the same git-ignored deploy.config.ps1 that deploy.ps1 uses,
# dot-sourced here so the token is never passed on a command line. ASCII-only:
# Windows PowerShell reads a BOM-less .ps1 as the ANSI codepage.
#
# Exit codes: 0 = applied or nothing to do, non-zero = not applied.
param([int]$MaxAgeHours = 6)
$ErrorActionPreference = "Stop"

# Derived from this script's own location, never from %USERPROFILE%: a remoting
# session lands as svc-remote, whose home directory has no repo in it.
$root = $PSScriptRoot
$file = Join-Path $root "d1\players_link.sql"

if (-not (Test-Path $file)) {
  Write-Host "players d1: $file not found - run padel-db/export_d1_players.py first."
  exit 1
}

$age = (Get-Date) - (Get-Item $file).LastWriteTime
if ($age.TotalHours -gt $MaxAgeHours) {
  Write-Host ("players d1: {0} is {1:N1} h old - the export did not run, not applying it." -f $file, $age.TotalHours)
  exit 1
}

$stmts = @(Get-Content $file | Where-Object { $_ -match '^INSERT ' }).Count
if ($stmts -eq 0) {
  Write-Host "players d1: no linked player is missing a row - nothing to load."
  exit 0
}

$cfg = Join-Path $root "..\danskepadelklip-site\deploy.config.ps1"
if (-not (Test-Path $cfg)) { Write-Host "players d1: missing $cfg"; exit 1 }
. $cfg
if (-not $env:CLOUDFLARE_API_TOKEN) { Write-Host "players d1: no token in config."; exit 1 }

Set-Location $root
Write-Host "players d1: applying $stmts row(s) to players..."
& npx wrangler d1 execute padelticker-history --remote --file d1/players_link.sql --yes
if ($LASTEXITCODE -ne 0) {
  Write-Host "players d1: FAILED ($LASTEXITCODE) - the next night re-sends the same rows."
  exit $LASTEXITCODE
}
Write-Host "players d1: applied $stmts row(s)."
