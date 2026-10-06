# D1 budget guard for every PadelTicker bulk load. Dot-source it AFTER
# deploy.config.ps1 (it needs CLOUDFLARE_API_TOKEN), then ask before applying:
#
#   . (Join-Path $root "scripts\d1-budget.ps1")
#   $gate = Test-D1Budget -Label "elo delta" -Statements $lines.Count
#   if (-not $gate.Go) { exit $gate.ExitCode }
#
# WHY. The D1 free-tier caps (5M rows read, 100k rows written per UTC day) are
# ACCOUNT-wide and enforced since 2026-09-01: over them, EVERY D1 query on the
# account fails with 1101 / code 7500 until 00:00 UTC. On 2026-10-01 one full
# PadelTicker reload (18:00-19:00 UTC: 9.5M read, 3.0M written) took down the
# site's profile API, publish-pump and with it the 3090's command queue, and
# that night's matches load. Normal site traffic is ~1M reads/day; the bulk
# loads are the only thing that has ever reached the cap.
#
# RULE. Today's account-wide usage (Cloudflare GraphQL, since 00:00 UTC) plus
# this load's estimate must stay under the cap minus a reserve for the rest of
# the day's site traffic. Otherwise the load is DEFERRED to the next run.
# Estimate: one statement per line (the exporters write it that way), ~3 row
# writes each once indexes are counted (measured, see load_players_d1.ps1), and
# as many reads.
#
# DEFERRED IS NOT FAILED. A deferral exits 0, so the nightly does not count it,
# and the next night heals it (matches/players re-read D1, earnings keeps its
# pending state, elo/stats use the carry file below). The THIRD deferral in a
# row of the same load exits 4, so the nightly flags it and a person looks.
# The usage lookup failing defers too: a load that cannot see the budget does
# not spend it.
#
# CARRY (elo, stats). Their exporters advance the delta state at EXPORT time,
# so a delta that is not applied would otherwise be lost for good. Use
# Join-D1Carry before applying and Complete-D1Carry after: an unapplied delta
# is kept in d1\<name>_carry.sql and sent first next time. Order is preserved
# (carry, then tonight), and every statement is INSERT OR REPLACE / DELETE by
# id, so re-sending is safe.
#
# ASCII-only: Windows PowerShell reads a BOM-less .ps1 as the ANSI codepage.

$script:D1Cap      = @{ Reads = 5000000; Writes = 100000 }
$script:D1Reserve  = @{ Reads = 1000000; Writes = 5000 }
$script:D1GuardDir = Join-Path (Split-Path -Parent $PSScriptRoot) "d1"
$script:D1DeferFile = Join-Path $script:D1GuardDir "budget-deferrals.json"
$script:D1DeferLimit = 3

function Get-D1Usage {
  # Account-wide rows read/written since 00:00 UTC today, all databases.
  if (-not $env:CLOUDFLARE_API_TOKEN) { throw "no CLOUDFLARE_API_TOKEN" }
  $h = @{ Authorization = "Bearer $env:CLOUDFLARE_API_TOKEN" }
  $acct = $env:CLOUDFLARE_ACCOUNT_ID
  if (-not $acct) {
    $acct = (Invoke-RestMethod "https://api.cloudflare.com/client/v4/accounts" -Headers $h -TimeoutSec 30).result[0].id
  }
  if (-not $acct) { throw "no Cloudflare account id" }
  $from = [DateTime]::UtcNow.ToString("yyyy-MM-dd") + "T00:00:00Z"
  $q = 'query($a:String!,$s:Time!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:1000,filter:{datetimeHour_geq:$s}){sum{rowsRead rowsWritten}}}}}'
  $body = @{ query = $q; variables = @{ a = $acct; s = $from } } | ConvertTo-Json -Depth 5 -Compress
  $r = Invoke-RestMethod "https://api.cloudflare.com/client/v4/graphql" -Method Post -Headers $h -ContentType "application/json" -Body $body -TimeoutSec 60
  if ($r.errors) { throw ("GraphQL: " + (($r.errors | ForEach-Object { $_.message }) -join "; ")) }
  $g = @($r.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups)
  $reads = 0L; $writes = 0L
  foreach ($x in $g) { $reads += [long]$x.sum.rowsRead; $writes += [long]$x.sum.rowsWritten }
  return [pscustomobject]@{ Reads = $reads; Writes = $writes; Since = $from }
}

function Read-D1Deferrals {
  if (-not (Test-Path $script:D1DeferFile)) { return @{} }
  try {
    $o = [IO.File]::ReadAllText($script:D1DeferFile) | ConvertFrom-Json
    $h = @{}; foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = [int]$p.Value }; return $h
  } catch { return @{} }
}

function Write-D1Deferrals($h) {
  [IO.File]::WriteAllText($script:D1DeferFile, ($h | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
}

function Test-D1Budget {
  param(
    [Parameter(Mandatory)][string]$Label,
    [Parameter(Mandatory)][int]$Statements,
    [int]$WritesPer = 3,
    [int]$ReadsPer = 3,
    [long]$ExtraReads = 0,
    # Writes a statement count cannot see: a relink UPDATE moves a whole career.
    [long]$ExtraWrites = 0
  )
  $estW = [long]$Statements * $WritesPer + $ExtraWrites
  $estR = [long]$Statements * $ReadsPer + $ExtraReads
  $defer = Read-D1Deferrals
  $why = $null
  try {
    $u = Get-D1Usage
    Write-Host ("{0}: D1 today (UTC, all databases) read {1:N0} / {2:N0}, written {3:N0} / {4:N0}; this load ~{5:N0} reads, ~{6:N0} writes" -f `
      $Label, $u.Reads, $script:D1Cap.Reads, $u.Writes, $script:D1Cap.Writes, $estR, $estW)
    if (($u.Reads + $estR) -gt ($script:D1Cap.Reads - $script:D1Reserve.Reads)) {
      $why = "reads would reach {0:N0} (limit {1:N0} after a {2:N0} reserve for site traffic)" -f ($u.Reads + $estR), ($script:D1Cap.Reads - $script:D1Reserve.Reads), $script:D1Reserve.Reads
    } elseif (($u.Writes + $estW) -gt ($script:D1Cap.Writes - $script:D1Reserve.Writes)) {
      $why = "writes would reach {0:N0} (limit {1:N0} after a {2:N0} reserve)" -f ($u.Writes + $estW), ($script:D1Cap.Writes - $script:D1Reserve.Writes), $script:D1Reserve.Writes
    }
  } catch {
    $why = "could not read today's D1 usage ($($_.Exception.Message))"
  }
  if (-not $why) {
    if ($defer.ContainsKey($Label)) { $defer.Remove($Label); Write-D1Deferrals $defer }
    return [pscustomobject]@{ Go = $true; ExitCode = 0 }
  }
  $n = 1 + $(if ($defer.ContainsKey($Label)) { $defer[$Label] } else { 0 })
  $defer[$Label] = $n
  Write-D1Deferrals $defer
  $code = if ($n -ge $script:D1DeferLimit) { 4 } else { 0 }
  Write-Host ("{0}: DEFERRED by the D1 budget guard - {1}. Deferral {2} in a row; the next run retries.{3}" -f `
    $Label, $why, $n, $(if ($code) { " Limit of $($script:D1DeferLimit) reached - exit 4 so the nightly flags it." } else { "" }))
  return [pscustomobject]@{ Go = $false; ExitCode = $code }
}

function Join-D1Carry {
  # Returns the path of the file to apply: carry (if any) followed by tonight's
  # delta, written to d1\<name>_apply.sql. Lines are copied as bytes-of-UTF-8 so
  # player names never pass through the ANSI codepage.
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Delta)
  $carry = Join-Path $script:D1GuardDir "$($Name)_carry.sql"
  $apply = Join-Path $script:D1GuardDir "$($Name)_apply.sql"
  $utf8 = New-Object Text.UTF8Encoding $false
  $parts = @()
  if (Test-Path $carry) { $parts += [IO.File]::ReadAllText($carry, $utf8).TrimEnd("`r", "`n") }
  if (Test-Path $Delta) { $parts += [IO.File]::ReadAllText($Delta, $utf8).TrimEnd("`r", "`n") }
  $text = (@($parts | Where-Object { $_ }) -join "`n")
  if ($text) { $text += "`n" }
  [IO.File]::WriteAllText($apply, $text, $utf8)
  return $apply
}

function Complete-D1Carry {
  # After the apply attempt: success clears the carry, anything else keeps the
  # whole combined file as the new carry so nothing is lost.
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][bool]$Applied)
  $carry = Join-Path $script:D1GuardDir "$($Name)_carry.sql"
  $apply = Join-Path $script:D1GuardDir "$($Name)_apply.sql"
  if ($Applied) {
    if (Test-Path $carry) { Remove-Item -LiteralPath $carry }
  } elseif (Test-Path $apply) {
    Copy-Item -LiteralPath $apply -Destination $carry -Force
  }
}
