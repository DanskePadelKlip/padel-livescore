# Apply d1/elo_delta.sql - the Elo rows that moved since the last export - to
# PadelTicker's D1.
#
# Why a delta and not the whole table: a full reload is ~13,800 INSERTs but
# ~41,000 D1 row-writes once indexes are counted, which is 41% of the 100k/day
# free tier. A typical night moves a few hundred players, so the delta costs a
# few thousand writes and can run every night.
#
# Auth comes from the same git-ignored deploy.config.ps1 that deploy.ps1 uses,
# dot-sourced here so the token is never passed on a command line.
#
# Exit codes: 0 = applied or nothing to do, non-zero = the load failed.
$ErrorActionPreference = "Stop"

# Derived from this script's own location, never from %USERPROFILE%: a remoting
# session lands as svc-remote, so USERPROFILE would point at a home directory
# that has no repo in it and the script would report "nothing to load" forever.
$root  = $PSScriptRoot
$delta = Join-Path $root "d1\elo_delta.sql"

if (-not (Test-Path $delta)) {
  Write-Host "elo delta: $delta not found - run export_d1_elo.py first."
  exit 1
}

# An empty delta is the normal case on a quiet night. Skip the wrangler call
# entirely rather than paying a round trip to say nothing changed.
$lines = @(Get-Content $delta | Where-Object { $_.Trim() })
if ($lines.Count -eq 0) {
  Write-Host "elo delta: no rows changed - nothing to load."
  exit 0
}

$cfg = Join-Path $root "..\danskepadelklip-site\deploy.config.ps1"
if (-not (Test-Path $cfg)) { Write-Host "elo delta: missing $cfg"; exit 1 }
. $cfg
if (-not $env:CLOUDFLARE_API_TOKEN) { Write-Host "elo delta: no token in config."; exit 1 }

Set-Location $root
Write-Host "elo delta: applying $($lines.Count) row(s) to D1..."
& npx wrangler d1 execute padelticker-history --remote --file d1/elo_delta.sql --yes
if ($LASTEXITCODE -ne 0) { Write-Host "elo delta: FAILED ($LASTEXITCODE)"; exit $LASTEXITCODE }
Write-Host "elo delta: applied $($lines.Count) row(s)."
