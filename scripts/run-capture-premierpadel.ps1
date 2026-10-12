# Launcher for the daily Premier Padel capture (see scripts/capture-premierpadel.mjs).
# Task: PadelTicker-PremierPadel-Daily, via run-hidden.vbs so nothing paints.
#
# ASCII ONLY IN THIS FILE (Windows PowerShell 5.1 reads .ps1 as ANSI).
#
# Incremental and idempotent: a failed or missed run loses nothing, the next one
# picks up every finished match that still has no stats file. Safe to re-run.
#
# After the capture it rebuilds public/data/ppstats/ (scripts/build-ppstats.mjs, the
# match page's stats panel) and commits + pushes ONLY that folder when it changed.
# The push matters: GitHub Actions deploys origin/main, so stats that exist only in
# this working tree would vanish from the site at the next Actions deploy. The
# refresh daemon ships the working tree on its next cycle either way.
#
# Exit: 0 = ok, 1 = node capture failed (API/network; see the log), 3 = already
# running, 4 = stats built but the push failed (commit unwound, files kept),
# 5 = stats build failed.
$ErrorActionPreference = "Continue"
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
# Explicit, not ~: a remoting or SYSTEM run would otherwise write to another profile.
$env:PP_CAPTURE_DIR = "C:\Users\Dansk\premierpadel-capture"
# Never let git ask a human anything (a credential dialog would hang the task).
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "never"

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*capture-premierpadel*' }
if ($running) { exit 3 }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
$log = "logs\capture-premierpadel.log"
function Log([string]$m) { "[$([DateTime]::UtcNow.ToString('o'))] $m" | Out-File -Append -Encoding ascii $log }

Log "start"
# Through cmd, not *>>: PS 5.1 redirection writes UTF-16 and would interleave with
# the ASCII marker lines. node is on PATH (set above).
cmd /c "node scripts\capture-premierpadel.mjs >> $log 2>&1"
$code = $LASTEXITCODE
Log "exit $code"
$exit = 0
if ($code -ne 0) { $exit = 1 }

# Stats files, even after a partial capture: whatever did land is worth showing.
cmd /c "node scripts\build-ppstats.mjs >> $log 2>&1"
if ($LASTEXITCODE -ne 0) {
  Log "ppstats build FAILED (exit $LASTEXITCODE); restoring public/data/ppstats from HEAD"
  cmd /c "git checkout -- public/data/ppstats >> $log 2>&1"
  if ($exit -eq 0) { $exit = 5 }
  exit $exit
}

# git through cmd so its stderr progress lines go to the log instead of becoming
# PowerShell errors; judged by exit code only.
cmd /c "git add -- public/data/ppstats >> $log 2>&1"
cmd /c "git diff --cached --quiet -- public/data/ppstats"
if ($LASTEXITCODE -eq 0) { Log "ppstats: no change"; exit $exit }

# Commit only this folder (other writers keep WIP in this tree), then push.
cmd /c "git -c user.name=PadelTicker -c user.email=danskepadelklip@gmail.com commit -q -m ""Premier Padel stats: daily refresh $(Get-Date -Format yyyy-MM-dd)"" -m ""Automated by PadelTicker-PremierPadel-Daily (scripts/run-capture-premierpadel.ps1)."" -- public/data/ppstats >> $log 2>&1"
if ($LASTEXITCODE -ne 0) { Log "ppstats commit failed"; exit 4 }
cmd /c "git push origin HEAD:main >> $log 2>&1"
if ($LASTEXITCODE -ne 0) {
  # main moved or no credential. No rebase here: this tree always carries other
  # writers' WIP, and a rebase/autostash over it at 06:15 is a bigger risk than a
  # day's lag. Unwind the commit so this checkout never sits ahead of main; the
  # files stay, the daemon deploys them, tomorrow's run commits them again.
  cmd /c "git reset --soft HEAD~1 >> $log 2>&1"
  Log "WARN ppstats push failed; commit unwound, files kept in the tree"
  exit 4
}
Log "ppstats committed and pushed"
exit $exit
