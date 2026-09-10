# Apply d1/earnings_delta.sql - the player_earnings rows that changed since the
# last SUCCESSFUL load - to PadelTicker's D1.
#
# The table behind the prize-money tile on every player profile: RankedIn-linked
# players under their rankedin_id, every other FIP player under the fip-<slug> id
# their profile already uses - about 5,500 rows. Reloaded in full that would be
# ~11,000 D1 row-writes every night, 11% of the 100k/day free tier. The delta is
# only the players with a newly priced result, and a quiet night skips the call.
#
# STATE. padel-db/export_earnings.py diffs against d1/earnings_state.json (what
# the table held after the last load that succeeded) and writes
# earnings_state.pending.json. This script promotes pending -> state ONLY after
# wrangler succeeds, so a failed load is re-sent by the next night's delta instead
# of being silently forgotten.
#
# Refuses a STALE delta. The nightly runs this straight after the export; if the
# export failed or refused a suspicious shrink, the delta on disk is from an
# earlier run and must not be applied again as if it were tonight's.
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
$root    = $PSScriptRoot
$delta   = Join-Path $root "d1\earnings_delta.sql"
$state   = Join-Path $root "d1\earnings_state.json"
$pending = Join-Path $root "d1\earnings_state.pending.json"

if (-not (Test-Path $delta)) {
  Write-Host "earnings d1: $delta not found - run padel-db/export_earnings.py first."
  exit 1
}
$age = (Get-Date) - (Get-Item $delta).LastWriteTime
if ($age.TotalHours -gt $MaxAgeHours) {
  Write-Host ("earnings d1: {0} is {1:N1} h old - the export did not run, not applying it." -f $delta, $age.TotalHours)
  exit 1
}

$stmts = @(Get-Content $delta | Where-Object { $_ -match '^(INSERT|DELETE) ' }).Count
if ($stmts -eq 0) {
  if (Test-Path $pending) { Move-Item -Force $pending $state }
  Write-Host "earnings d1: no rows changed - nothing to load."
  exit 0
}

$cfg = Join-Path $root "..\danskepadelklip-site\deploy.config.ps1"
if (-not (Test-Path $cfg)) { Write-Host "earnings d1: missing $cfg"; exit 1 }
. $cfg
if (-not $env:CLOUDFLARE_API_TOKEN) { Write-Host "earnings d1: no token in config."; exit 1 }

Set-Location $root
Write-Host "earnings d1: applying $stmts change(s) to player_earnings..."
& npx wrangler d1 execute padelticker-history --remote --file d1/earnings_delta.sql --yes
if ($LASTEXITCODE -ne 0) {
  Write-Host "earnings d1: FAILED ($LASTEXITCODE) - state not advanced; the next delta re-sends these rows."
  exit $LASTEXITCODE
}
if (Test-Path $pending) { Move-Item -Force $pending $state }
Write-Host "earnings d1: applied $stmts change(s)."
