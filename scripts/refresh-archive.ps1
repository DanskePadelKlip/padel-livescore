# PadelTicker results archive refresh - run by the padel-db laptop nightly.
#
# ASCII ONLY IN THIS FILE. Windows PowerShell 5.1 reads .ps1 as ANSI (see
# refresh-national-teams.ps1, whose pattern this follows).
#
# WHAT IT DOES, nightly:
#   1. Fast-forwards the laptop checkout to origin/main (as refresh-national-teams.ps1).
#   2. Runs padel-db/export_archive.py into a TEMP folder: one file per FIP and RankedIn
#      tournament plus index.json. The exporter only READS padel.db, and it runs inside
#      the nightly's own sequence, so it never overlaps another padel.db writer.
#   3. Refuses the result if it lists fewer tournaments than the live index (a short
#      read of padel.db must never shrink the archive), then copies it over
#      public/data/archive. Files of tournaments no longer exported are left in place,
#      exactly as running the exporter in place always did.
#   4. Commits and pushes only public/data/archive/index.json and public/data/archive/t,
#      and only if something changed. The files are tracked, so an unpushed commit
#      would be undone by the next GitHub Actions deploy of origin/main.
#
# WHY. export_archive.py only ever ran by hand: index.json was last written on
# 2026-08-28 and its newest event started on 2026-07-10, so no tournament after that
# had a permanent page on padelticker.com (PLAN.md Phase 0.4, 2026-10-21).
#
# The refresh daemon (scripts/refresh-loop.js) deploys the working tree every cycle,
# so copying the files in IS the deploy. Nothing else to trigger.
param(
  [string]$Repo = "C:\Users\Dansk\AI Projects\padel-livescore",
  [string]$DbRepo = "C:\Users\Dansk\AI Projects\padel-db",
  [switch]$NoGit,
  [switch]$NoCopy
)

$ErrorActionPreference = "Stop"
$logDir = Join-Path $Repo "logs"
$log = Join-Path $logDir "archive-refresh.log"
if (-not (Test-Path $Repo)) { throw "repo not found: $Repo" }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

function Write-Log([string]$msg) {
  $line = ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg)
  [System.IO.File]::AppendAllText($log, $line + "`r`n", [System.Text.UTF8Encoding]::new($false))
  Write-Host $line
}
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 512KB)) {
  $keep = Get-Content $log -Tail 2000
  [System.IO.File]::WriteAllLines($log, $keep, [System.Text.UTF8Encoding]::new($false))
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$env:GIT_ASKPASS = ''

# Native git under Continue, judged by $LASTEXITCODE (git writes progress to stderr,
# which 'Stop' would turn into a terminating error). Every '--' is quoted: a bare --
# is PowerShell's own end-of-parameters token.
function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git -C $Repo @Args 2>&1 | ForEach-Object { $_.ToString() }
    $script:gitExit = $LASTEXITCODE
    return $out
  } finally { $ErrorActionPreference = $old }
}

$archive = Join-Path $Repo "public\data\archive"
$tmp = Join-Path $env:TEMP ("pt-archive-" + (Get-Date -Format yyyyMMddHHmmss))
$exit = 0
Write-Log "=== archive refresh start ==="

try {
  $canPush = $false
  if (-not $NoGit) {
    Invoke-Git fetch origin main | Out-Null
    # Same set-aside as refresh-national-teams.ps1: index.html carries the daemon's
    # stamp, players-lite.json is written by the nightly D1 load and never committed.
    $liteRel = 'public/data/players-lite.json'
    $liteKeep = Join-Path $env:TEMP "players-lite.archive-keep.json"
    if (Test-Path (Join-Path $Repo $liteRel)) { Copy-Item -LiteralPath (Join-Path $Repo $liteRel) -Destination $liteKeep -Force }
    Invoke-Git checkout '--' public/index.html $liteRel | Out-Null
    $before = (Invoke-Git rev-parse HEAD) -join ''
    $mergeOut = Invoke-Git merge --ff-only origin/main
    $canPush = ($script:gitExit -eq 0)
    if (Test-Path $liteKeep) { Copy-Item -LiteralPath $liteKeep -Destination (Join-Path $Repo $liteRel) -Force }
    $after = (Invoke-Git rev-parse HEAD) -join ''
    if (-not $canPush) { Write-Log "WARN merge --ff-only refused (git said: $($mergeOut -join '; ')); will not push this run" }
    elseif ($before -ne $after) { Write-Log "fast-forwarded $($before.Substring(0,7)) -> $($after.Substring(0,7))" }
  } else { Write-Log "-NoGit: skipping fetch/merge" }

  # 1. export into a temp folder
  $py = Join-Path $DbRepo ".venv\Scripts\python.exe"
  if (-not (Test-Path $py)) { throw "padel-db python not found: $py" }
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $env:PADEL_DB = Join-Path $DbRepo "padel.db"
  $env:PADEL_ARCHIVE_OUT = $tmp
  $env:PYTHONIOENCODING = "utf-8"
  Push-Location $DbRepo
  try {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $out = & $py export_archive.py 2>&1 | ForEach-Object { $_.ToString() }
    $pyExit = $LASTEXITCODE
    $ErrorActionPreference = $old
  } finally { Pop-Location }
  $out | ForEach-Object { Write-Log "export: $_" }
  if ($pyExit -ne 0) { throw "export_archive.py exited $pyExit" }

  # 2. sanity: never shrink the archive
  $newIdx = Get-Content -LiteralPath (Join-Path $tmp "index.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $oldCount = 0
  $oldPath = Join-Path $archive "index.json"
  if (Test-Path $oldPath) { $oldCount = [int]((Get-Content -LiteralPath $oldPath -Raw -Encoding UTF8 | ConvertFrom-Json).count) }
  $newCount = [int]$newIdx.count
  $newest = ($newIdx.tournaments | Where-Object { $_.start } | Select-Object -First 1).start
  Write-Log "exported $newCount tournaments (live index: $oldCount), newest start $newest"
  if ($newCount -lt $oldCount) { throw "export has FEWER tournaments than the live index ($newCount < $oldCount); nothing copied" }

  if ($NoCopy) {
    Write-Log "-NoCopy: export left in $tmp, nothing copied"
  } else {
    # 3. copy in (this is the deploy)
    $tdir = Join-Path $archive "t"
    if (-not (Test-Path $tdir)) { New-Item -ItemType Directory -Path $tdir | Out-Null }
    Copy-Item -Path (Join-Path $tmp "t\*.json") -Destination $tdir -Force
    Copy-Item -LiteralPath (Join-Path $tmp "index.json") -Destination $oldPath -Force
    Remove-Item -LiteralPath $tmp -Recurse -Force
  }

  # 4. commit only the archive paths, only if they moved
  $paths = @('public/data/archive/index.json', 'public/data/archive/t')
  $dirty = (Invoke-Git status --porcelain --untracked-files=all '--' @paths) | Where-Object { $_ }
  if (-not $dirty) {
    Write-Log "no change"
  } elseif ($NoGit -or $NoCopy) {
    Write-Log "-NoGit/-NoCopy: would commit $(@($dirty).Count) path(s)"
  } else {
    Write-Log "changed: $(@($dirty).Count) path(s)"
    Invoke-Git add '--' @paths | Out-Null
    $msg = "Results archive: nightly refresh $(Get-Date -Format yyyy-MM-dd) ($newCount tournaments)"
    # Pathspec commit: the daemon keeps public/data/archive/wpt.json staged, and a
    # bare commit would sweep it in.
    Invoke-Git -c user.name=PadelTicker -c user.email=danskepadelklip@gmail.com commit -m $msg -m 'Automated by the padel-db laptop nightly (scripts/refresh-archive.ps1).' '--' @paths | Out-Null
    if ($script:gitExit -ne 0) { throw "git commit failed" }
    if ($canPush) {
      $p = Invoke-Git -c credential.helper= push origin HEAD:main
      if ($script:gitExit -ne 0) {
        # Unwind and keep the files: an unpushable commit would put this checkout
        # ahead of main and make every later --ff-only refuse (see the national-teams
        # job). The daemon still deploys the files; only the git record waits.
        # Mixed, not --soft: left staged, the new files would ride along in the next
        # bare commit another job makes on this tree.
        Invoke-Git reset HEAD~1 | Out-Null
        Write-Log "WARN push failed, commit unwound - the files are in the tree and still deploy: $($p -join '; ')"
        $exit = 4
      } else { Write-Log "committed and pushed" }
    } else { Write-Log "committed locally; push skipped - the fast-forward earlier this run did not succeed" }
  }
}
catch {
  Write-Log "ERROR $($_.Exception.Message)"
  $exit = 2
}
finally {
  if ((-not $NoCopy) -and (Test-Path $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Log "=== archive refresh end (exit $exit) ==="
exit $exit
