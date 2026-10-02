# Apply the player_stats table to PadelTicker's D1.
#
# WHAT IT FIXES. /api/player/:id builds its summary from D1's `matches` table,
# which only ever held FIP + rin_matches -- never dpf_matches or the team league.
# Measured 2026-09-25: of the 9,259 men with a rated Elo, 6,761 had ZERO matches on
# their profile and the median rated player saw 0% of their own record, while the
# Elo panel beside it was built from all of them. player_stats carries the whole
# career as one precomputed row per player, so the count is right without loading
# 283k raw match rows (~40 days of the free tier).
#
# Mirrors load_elo_d1.ps1: same token source, same delta-by-default contract.
#
#   -Full   apply d1/stats_schema.sql then d1/stats_rows.sql (first load, or a
#           deliberate reload), then re-seed the delta state so the next nightly
#           delta is measured against what D1 now actually holds.
#   (none)  apply d1/stats_delta.sql -- the nightly case.
#
# BUDGET. A full load is 26,544 rows, ~53k D1 row-writes once the primary-key
# index is counted, about half the 100k/day free tier. Do not run -Full on a night
# that also does an elo --rank-refresh (that alone is ~41k). The nightly delta is a
# few hundred rows.
#
# Exit codes: 0 = applied or nothing to do, non-zero = the load failed.
param([switch]$Full)
$ErrorActionPreference = "Stop"

# From $PSScriptRoot, never %USERPROFILE%: a remoting session lands as svc-remote,
# whose home has no repo, and the script would report "nothing to load" forever.
$root = $PSScriptRoot

$cfg = Join-Path $root "..\danskepadelklip-site\deploy.config.ps1"
if (-not (Test-Path $cfg)) { Write-Host "stats: missing $cfg"; exit 1 }
. $cfg
if (-not $env:CLOUDFLARE_API_TOKEN) { Write-Host "stats: no token in config."; exit 1 }
Set-Location $root
# Budget guard + carry: see scripts\d1-budget.ps1. export_d1_stats.py writes
# stats_state.json at EXPORT time, so an unapplied delta is kept in
# d1\stats_carry.sql and sent ahead of the next one.
. (Join-Path $root "scripts\d1-budget.ps1")

if ($Full) {
    $schema = Join-Path $root "d1\stats_schema.sql"
    $rows   = Join-Path $root "d1\stats_rows.sql"
    foreach ($f in @($schema, $rows)) {
        if (-not (Test-Path $f)) { Write-Host "stats: $f not found - run export_d1_stats.py first."; exit 1 }
    }
    $n = @(Get-Content $rows | Where-Object { $_.Trim() }).Count
    Write-Host "stats: FULL load - schema + $n row(s). This is ~$([int]($n*2/1000))k row-writes."
    $gate = Test-D1Budget -Label "stats full" -Statements $n -WritesPer 2
    if (-not $gate.Go) { Write-Host "stats: FULL load deferred - run it again early in a UTC day."; exit $gate.ExitCode }
    & npx wrangler d1 execute padelticker-history --remote --file d1/stats_schema.sql --yes
    if ($LASTEXITCODE -ne 0) { Write-Host "stats: schema FAILED ($LASTEXITCODE)"; exit $LASTEXITCODE }
    & npx wrangler d1 execute padelticker-history --remote --file d1/stats_rows.sql --yes
    if ($LASTEXITCODE -ne 0) { Write-Host "stats: rows FAILED ($LASTEXITCODE)"; exit $LASTEXITCODE }
    Write-Host "stats: applied $n row(s)."
    Write-Host "stats: NOW RUN  python export_d1_stats.py --seed  so the next delta is"
    Write-Host "       measured against what D1 holds, not against an empty state."
    exit 0
}

$delta = Join-Path $root "d1\stats_delta.sql"
if (-not (Test-Path $delta)) {
    Write-Host "stats: $delta not found - run export_d1_stats.py first."
    exit 1
}
$apply = Join-D1Carry -Name "stats" -Delta $delta
# An empty delta is the normal quiet-night case: skip the round trip entirely.
$lines = @(Get-Content $apply | Where-Object { $_.Trim() })
if ($lines.Count -eq 0) {
    Write-Host "stats: no rows changed - nothing to load."
    exit 0
}
$gate = Test-D1Budget -Label "stats delta" -Statements $lines.Count -WritesPer 2
if (-not $gate.Go) { Complete-D1Carry -Name "stats" -Applied $false; exit $gate.ExitCode }
Write-Host "stats: applying $($lines.Count) row(s) to D1..."
& npx wrangler d1 execute padelticker-history --remote --file d1/stats_apply.sql --yes
$code = $LASTEXITCODE
Complete-D1Carry -Name "stats" -Applied ($code -eq 0)
if ($code -ne 0) { Write-Host "stats: FAILED ($code) - kept in d1\stats_carry.sql for the next run."; exit $code }
Write-Host "stats: applied $($lines.Count) row(s)."
