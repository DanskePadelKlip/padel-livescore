# Finishes the match_players country-case backfill in nightly batches, then removes
# itself from the schedule.
#
# Context: padel.db stores FIP countries as upper-case IOC codes and RankedIn ones as
# lower-case ISO-2. The exporters normalise on the way out now (padel-db country_code.py),
# but the rows already in D1 predate that, and there are ~189k of them left -- more than
# one day's free-tier write budget, hence batching.
#
# WHY 01:35: D1's free-tier caps reset at 00:00 UTC = 02:00 local, and this job spends
# whatever the day did NOT use. Running just AFTER a reset would instead claim ~95k of a
# fresh day and starve everything else -- which is exactly the collision seen on
# 2026-08-28, when a ~97k bulk import at 11:00 local ate the whole day's budget.
#
# Self-sizing: asks the GraphQL analytics API what today's UTC day has already written
# and takes only the remainder, under a 95k ceiling. Self-terminating: an UPDATE that
# changes 0 rows means the backfill is done, so the task disables itself.
#
# Runs as SYSTEM from Task Scheduler; every path is absolute for that reason.
param([switch]$DryRun)

$ErrorActionPreference = "Stop"
$repo   = "C:\Users\Dansk\AI Projects\padel-livescore"
$log    = Join-Path $repo "logs\d1-country-backfill.log"
$dbName = "padelticker-history"
$dbId   = "e811bb33-b2ea-44a4-82a3-7a368770c293"
$task   = "PadelTicker-D1-CountryBackfill"
$CEILING = 95000   # leave ~5k of the 100k/day for the site's own writes
$FLOOR   = 5000    # not worth a run below this

function Say($m) {
  # NB: format with -f, not Get-Date -Format. Under Task Scheduler the culture can
  # localise ":" (the .NET time-separator placeholder) to "." -- which also silently
  # broke the ISO timestamp this script sends to the analytics API.
  $n = Get-Date
  $line = "{0:0000}-{1:00}-{2:00} {3:00}:{4:00}:{5:00}  {6}" -f $n.Year, $n.Month, $n.Day, $n.Hour, $n.Minute, $n.Second, $m
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
. "C:\Users\Dansk\AI Projects\danskepadelklip-site\deploy.config.ps1"

# --- how much of today's (UTC) write budget is already gone? ------------------
$u = [DateTime]::UtcNow
$dayStart = '{0:0000}-{1:00}-{2:00}T00:00:00Z' -f $u.Year, $u.Month, $u.Day
$gql = @{ query = "{ viewer { accounts(filter: {accountTag: `"$($env:CLOUDFLARE_ACCOUNT_ID)`"}) { d1AnalyticsAdaptiveGroups(limit: 100, filter: {datetimeHour_geq: `"$dayStart`", databaseId: `"$dbId`"}) { sum { rowsWritten } } } } }" } | ConvertTo-Json
$resp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/graphql" -Method Post `
  -Headers @{ Authorization = "Bearer $($env:CLOUDFLARE_API_TOKEN)"; "Content-Type" = "application/json" } -Body $gql
if ($resp.errors) { Say "analytics query failed: $($resp.errors | ConvertTo-Json -Compress)"; exit 1 }
# 5.1 Measure-Object takes a property NAME, not a scriptblock -- project first.
$used = ($resp.data.viewer.accounts.d1AnalyticsAdaptiveGroups | ForEach-Object { $_.sum.rowsWritten } | Measure-Object -Sum).Sum
if (-not $used) { $used = 0 }
$batch = [Math]::Min($CEILING - $used, 90000)
Say "today used=$used  batch=$batch"

if ($batch -lt $FLOOR) { Say "no headroom left today - skipping"; exit 0 }
if ($DryRun) { Say "DRY RUN - would update up to $batch rows"; exit 0 }

# --- one capped batch ---------------------------------------------------------
# rowid subquery, so re-running is safe and needs no cursor: rows already upper-case
# no longer match the predicate.
$sql = "UPDATE match_players SET country=UPPER(country) WHERE rowid IN (SELECT rowid FROM match_players WHERE country IS NOT NULL AND country<>UPPER(country) LIMIT $batch);"
Set-Location $repo
$out = & "C:\Program Files\nodejs\npx.cmd" wrangler d1 execute $dbName --remote --command $sql --json 2>&1 | Out-String
if ($out.IndexOf('[') -lt 0) { Say "wrangler returned no JSON: $($out.Trim())"; exit 1 }
$res = ($out.Substring($out.IndexOf('[')) | ConvertFrom-Json)[0]
$changed = $res.meta.changes
Say "success=$($res.success) changed=$changed"

# --- done? then take myself off the schedule ----------------------------------
if ($res.success -and $changed -eq 0) {
  Say "0 rows changed - backfill complete, disabling $task"
  Disable-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue | Out-Null
}
