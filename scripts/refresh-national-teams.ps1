# PadelTicker-NationalTeams-Weekly - keeps the national-teams section current.
#
# ASCII ONLY IN THIS FILE. Windows PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8
# em-dash decodes to three chars whose last byte is a smart closing quote, which
# terminates a string early and fails the parse. Hyphens, not dashes; straight
# quotes, not curly. (Same rule as install-refresh-task.ps1.)
#
# WHAT IT DOES, weekly:
#   1. Re-fetches every known FIP national-team edition from the team widget. This
#      is what picks up an event that has FINISHED since the last run - a rolling
#      event is published as a half record otherwise, so the World Cup qualifiers
#      only become complete on a later pass.
#   2. Rebuilds national-teams.json + national-teams-matches.json, with --check.
#   3. Asks padelfip's championships calendar whether any NEW team event exists,
#      and only REPORTS it. It never adds one: the label cannot be read off the
#      title ("FIP SENIOR WORLD CUP" is the veterans event), and a wrong label puts
#      a veterans result in a nation's national-team record.
#   4. Commits and pushes, but only the national-teams paths and only if something
#      actually changed.
#
# WHY IT RUNS HERE. The laptop is the only box that may deploy (public/data is
# generated here), and scripts/refresh-loop.js deploys the WORKING TREE every
# cycle - so rewriting these files is the deploy. Nothing else to trigger.
#
# The refusal is the point: if --check fails, the data files are restored from
# HEAD and nothing ships. A wrong placing is worse than a stale one.

# -Repo and -NoGit exist so this can be proved on another checkout before it is
# let near production: -NoGit runs the fetch, the build and discovery and reports
# what WOULD be committed, touching no git state at all.
param(
  [string]$Repo = "C:\Users\Dansk\AI Projects\padel-livescore",
  [switch]$NoGit,
  [switch]$NoPlayerIndex
)

$ErrorActionPreference = "Stop"
$repo = $Repo
$logDir = Join-Path $repo "logs"
$log = Join-Path $logDir "national-teams-refresh.log"

# Paths are absolute because this runs as a scheduled task: the execution account's
# %USERPROFILE% is not necessarily Dansk's, and a relative path would resolve
# against C:\WINDOWS\system32.
if (-not (Test-Path $repo)) { throw "repo not found: $repo" }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Write-Log, not Out-File: the default encoding here is the ANSI codepage, which
# mangles every accented player name the moment one reaches the log.
function Write-Log([string]$msg) {
  $line = ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg)
  [System.IO.File]::AppendAllText($log, $line + "`r`n", [System.Text.UTF8Encoding]::new($false))
  Write-Host $line
}

# Keep the log bounded - this runs weekly forever.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 512KB)) {
  $keep = Get-Content $log -Tail 2000
  [System.IO.File]::WriteAllLines($log, $keep, [System.Text.UTF8Encoding]::new($false))
}

# node writes UTF-8; PowerShell decodes a native child's stdout as the ANSI
# codepage unless told otherwise, so an em-dash arrives as three bytes and every
# accented player name in this log would be mojibake. Set it before the first
# child runs, not after.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# NEVER let git ask a human anything. The laptop has no stored GitHub credential -
# every push in this estate has come from the 3090 - so the first run of this job
# launched Git Credential Manager, which sat waiting on a sign-in dialog in Dansk's
# session and hung the task for four minutes until it was killed. A weekly job that
# hangs is worse than one that skips a push: the push is optional (refresh-loop.js
# deploys the working tree, so the site updates either way), the hang is not.
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$env:GIT_ASKPASS = ''

Set-Location $repo
# Every git call goes through here, and the reason is a trap that a -NoGit dry run
# cannot reach: git writes ordinary progress to STDERR ("From https://github.com/..."
# on a plain fetch), and under $ErrorActionPreference = 'Stop' PowerShell turns a
# native command's stderr into a TERMINATING error. The first version of this job
# died on its own git fetch, reporting a successful fetch as a failure. So: drop to
# Continue around the native call and judge it by $LASTEXITCODE, which is the only
# thing that actually says whether git succeeded.
#
# Every '--' below is QUOTED on purpose: bare -- is PowerShell's own
# end-of-parameters token and is consumed before the array reaches git, so
# `checkout -- <path>` silently becomes `checkout <path>` - fine until a path
# collides with a branch name, at which point it checks out the branch.
function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git -C $repo @Args 2>&1 | ForEach-Object { $_.ToString() }
    $script:gitExit = $LASTEXITCODE
    return $out
  } finally { $ErrorActionPreference = $old }
}
$node = "node"
$changed = $false
$exit = 0

Write-Log "=== refresh start ==="

try {
  # The daemon rewrites index.html's app.js?v= stamp constantly, so the tree is
  # never clean. Discard that one file (it is regenerated on the next cycle) and
  # fast-forward; if main has diverged, carry on but do not push at the end.
  $canPush = $false
  if (-not $NoGit) {
  Invoke-Git fetch origin main | Out-Null
  # index.html carries the daemon's app.js?v= stamp and players-lite.json is
  # regenerated below, so neither may block the fast-forward.
  Invoke-Git checkout '--' public/index.html public/data/players-lite.json | Out-Null
  $before = (Invoke-Git rev-parse HEAD).Trim()
  $mergeOut = Invoke-Git merge --ff-only origin/main
  $canPush = ($script:gitExit -eq 0)
  $after = (Invoke-Git rev-parse HEAD).Trim()
  if (-not $canPush) { Write-Log "WARN merge --ff-only refused (git said: $($mergeOut -join '; ')); will not push this run" }
  elseif ($before -ne $after) { Write-Log "fast-forwarded $($before.Substring(0,7)) -> $($after.Substring(0,7))" }
  } else { Write-Log "-NoGit: skipping fetch/merge" }

  # 0. the player index the name join reads. It comes from padel-db's export_d1.py
  #    and NOT from a script of our own: the fip-<slug> id rule lives in that file
  #    and is load-bearing - a second implementation would drift and orphan every
  #    live /player/fip-... URL. Nothing else schedules it, so it sat three weeks
  #    stale (24,895 players against 29,552 actual) and that staleness is directly
  #    names that do not link. It writes gitignored SQL chunks too; harmless.
  #    It runs BEFORE the build, because the build resolves names against it.
  if (-not $NoPlayerIndex) {
    $pdb = "C:\Users\Dansk\AI Projects\padel-db"
    $py  = Join-Path $pdb ".venv\Scripts\python.exe"
    # Explicit paths and the venv interpreter: a scheduled task gets a reduced PATH,
    # and export_d1.py defaults to ~ which expands per USER - as svc-remote it cannot
    # even find padel.db.
    if ((Test-Path $py) -and (Test-Path (Join-Path $pdb "padel.db"))) {
      $env:PYTHONUTF8 = "1"
      $env:PADEL_DB = Join-Path $pdb "padel.db"
      $env:PADEL_D1_OUT = Join-Path $repo "d1"
      $o = & $py (Join-Path $pdb "export_d1.py") 2>&1
      if ($LASTEXITCODE -ne 0) { Write-Log "WARN player index export failed: $($o | Select-Object -Last 3)" }
      else { $o | Where-Object { $_ -match 'players-lite|^done:' } | ForEach-Object { Write-Log "index: $_" } }
    } else {
      Write-Log "WARN no venv python or padel.db under $pdb - player index not refreshed"
    }
  }

  # 1. re-fetch
  $out = & $node "scripts\fetch-fip-team-draws.mjs" "--all" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "fetch failed: $($out -join '; ')" }
  $out | ForEach-Object { Write-Log "fetch: $_" }

  # 2. rebuild, with the checks
  $out = & $node "scripts\build-national-teams.mjs" "--check" 2>&1
  if ($LASTEXITCODE -ne 0) {
    $out | ForEach-Object { Write-Log "build: $_" }
    Invoke-Git checkout '--' public/data/national-teams.json public/data/national-teams-matches.json public/data/national-teams | Out-Null
    throw "build --check FAILED; data files restored from HEAD, nothing shipped"
  }
  $out | Where-Object { $_ -match '^wrote|^unchanged|player links|check |GAP|HELD BACK' } | ForEach-Object { Write-Log "build: $_" }
  $held = @($out | Where-Object { $_ -match 'HELD BACK (\S+):' } | ForEach-Object { $Matches[1] })

  # 3. anything new on the calendar? Reported, never added.
  $y = (Get-Date).Year
  $out = & $node "scripts\fetch-fip-team-draws.mjs" "--discover" "$y" "$($y+1)" 2>&1
  $disc = $LASTEXITCODE
  $out | ForEach-Object { Write-Log "discover: $_" }
  if ($disc -eq 3) { Write-Log "ACTION NEEDED: a new team championship exists and needs a hand-checked label" }

  # 4. commit only what this job owns, and only if it moved
  # A held-back draw that CHANGED is the one thing here that needs a person: the
  # World Cup qualifier finishing means it can be promoted out of the gap list. A
  # line every week would be noise, so this only speaks when the file moved.
  $movedHeld = @()
  foreach ($k in $held) {
    $f = "public/data/national-teams/draws/$k.json"
    if ((Invoke-Git status --porcelain '--' $f) -match '\S') { $movedHeld += $k }
  }
  if ($movedHeld) {
    Write-Log "ACTION NEEDED: held-back draw(s) changed: $($movedHeld -join ', ') - promote into TEAM_DRAWS if finished"
  }

  $paths = @('public/data/national-teams.json','public/data/national-teams-matches.json','public/data/national-teams','public/data/players-lite.json')
  $dirty = (Invoke-Git status --porcelain '--' @paths) | Where-Object { $_ }
  if ($dirty -and $NoGit) {
    Write-Log "-NoGit: would commit $($dirty.Count) path(s): $($dirty -join ' | ')"
  } elseif ($dirty) {
    $changed = $true
    Write-Log "changed: $($dirty -join ' | ')"
    Invoke-Git add '--' @paths | Out-Null
    $msg = "National teams: weekly refresh $(Get-Date -Format yyyy-MM-dd)"
    Invoke-Git -c user.name=PadelTicker -c user.email=danskepadelklip@gmail.com commit -m $msg -m 'Automated by PadelTicker-NationalTeams-Weekly (scripts/refresh-national-teams.ps1).' | Out-Null
    if ($canPush) {
      # -c credential.helper= disables the helper for this call alone, so a missing
      # credential is an immediate failure rather than a prompt. The commit stays
      # local and the log says so; nothing is lost but the sync.
      $p = Invoke-Git -c credential.helper= push origin HEAD:main
      if ($script:gitExit -ne 0) {
        # Unwind the commit and keep the files. A commit that cannot be pushed is
        # not harmless: it puts this checkout AHEAD of main, so next week's
        # merge --ff-only refuses, and the laptop quietly stops receiving every
        # future change to this job - one unpushable commit a week until someone
        # notices. Soft reset leaves the regenerated data exactly where it is, so
        # the daemon still deploys it; only the git record waits for a credential.
        Invoke-Git reset --soft HEAD~1 | Out-Null
        Write-Log "WARN push failed, commit unwound - the data is in the tree and still deploys, main just stays behind: $($p -join '; ')"
        $exit = 4
      }
      else { Write-Log "committed and pushed" }
    } else { Write-Log "committed locally; push skipped - the fast-forward earlier this run did not succeed" }
  } else {
    Write-Log "no change"
  }

  # The deploy is not ours to trigger: refresh-loop.js ships the working tree on
  # its next cycle. Say what it will carry so the log is the whole story.
  if ($changed) { Write-Log "the refresh daemon will deploy this on its next cycle" }
  if (($disc -eq 3 -or $movedHeld) -and $exit -eq 0) { $exit = 3 }
}
catch {
  Write-Log "ERROR $($_.Exception.Message)"
  $exit = 2
}

Write-Log "=== refresh end (exit $exit) ==="
exit $exit
