# Replace PadelTicker's player_earnings table in D1 with d1/earnings.sql.
#
# The table behind the prize-money tile on a player profile. padel-db's
# export_earnings.py writes the SQL as DROP + CREATE + one INSERT per linked
# player: ~190 rows, ~380 D1 row-writes with the index, under 0.4% of the
# 100k/day free tier. So unlike Elo (load_elo_d1.ps1) a full reload every night
# is affordable and there is no delta to maintain.
#
# Refuses a STALE or EMPTY file. The nightly runs this straight after
# export_earnings.py; if that export failed, last night's SQL is still on disk,
# and reloading it would report success while serving old figures. Anything
# older than -MaxAgeHours, or with no rows, fails the step instead, so the
# nightly's failure summary names it.
#
# Auth comes from the same git-ignored deploy.config.ps1 that deploy.ps1 uses,
# dot-sourced here so the token is never passed on a command line.
#
# Exit codes: 0 = applied, non-zero = not applied.
param([int]$MaxAgeHours = 6)
$ErrorActionPreference = "Stop"

# Derived from this script's own location, never from %USERPROFILE%: a remoting
# session lands as svc-remote, whose home directory has no repo in it.
$root = $PSScriptRoot
$sql  = Join-Path $root "d1\earnings.sql"

if (-not (Test-Path $sql)) {
  Write-Host "earnings d1: $sql not found - run padel-db/export_earnings.py first."
  exit 1
}
$age = (Get-Date) - (Get-Item $sql).LastWriteTime
if ($age.TotalHours -gt $MaxAgeHours) {
  Write-Host ("earnings d1: {0} is {1:N1} h old - the export did not run, not reloading." -f $sql, $age.TotalHours)
  exit 1
}
$rows = @(Get-Content $sql | Where-Object { $_ -like "INSERT*" }).Count
if ($rows -eq 0) {
  Write-Host "earnings d1: $sql has no rows - refusing to replace the table with an empty one."
  exit 1
}

$cfg = Join-Path $root "..\danskepadelklip-site\deploy.config.ps1"
if (-not (Test-Path $cfg)) { Write-Host "earnings d1: missing $cfg"; exit 1 }
. $cfg
if (-not $env:CLOUDFLARE_API_TOKEN) { Write-Host "earnings d1: no token in config."; exit 1 }

Set-Location $root
Write-Host "earnings d1: replacing player_earnings with $rows row(s)..."
& npx wrangler d1 execute padelticker-history --remote --file d1/earnings.sql --yes
if ($LASTEXITCODE -ne 0) { Write-Host "earnings d1: FAILED ($LASTEXITCODE)"; exit $LASTEXITCODE }
Write-Host "earnings d1: applied $rows row(s)."
