# Launcher for the adaptive PadelTicker refresh daemon (fetch -> deploy ->
# adaptive sleep). Runs anywhere Node can reach the internet - every source is now
# plain fetch + linkedom, so NO browser/Playwright is required (removed 2026-07-27).
# For hosted auto-refresh, use the GitHub Actions workflow
# (.github/workflows/refresh.yml) instead.
#
# ASCII ONLY IN THIS FILE. Windows PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8
# em-dash decodes to "a EUR "" and its last byte (0x94) is a smart closing quote -
# inside a string that terminates it early and the whole script fails to parse.
# Cost a live break on 2026-07-22. Keep punctuation plain.
$ErrorActionPreference = "Continue"
# make node/npx resolvable even under a reduced scheduled-task PATH
$env:PATH = "C:\Program Files\nodejs;$env:PATH"

# Machine-agnostic: derive the repo root from THIS script's location (scripts/ ->
# repo root) so the launcher works on whichever box is the always-on host, not a
# hardcoded user profile. Was pinned to C:\Users\Kimkr (old desktop); the always-on
# role now lives on the laptop.
$root = Split-Path -Parent $PSScriptRoot

# --- log plumbing ------------------------------------------------------------
# Windows PowerShell 5.1 turns a NATIVE command's stderr into NativeCommandError
# ErrorRecords when it is redirected with *>> , so every benign node warning was
# written to the log as a multi-line PowerShell error complete with a stack trace
# and "FullyQualifiedErrorId : NativeCommandError". A perfectly healthy daemon's
# log read like it was failing (27 such fake errors accumulated before this was
# fixed on 2026-08-28). Piping and unwrapping the records ourselves keeps the raw
# stderr line and nothing else.
#
# Encoding, same line: node emits UTF-8, the console codepage decoded it as CP437
# (so "->" arrived as "GaaE"), and *>> then wrote the result as UTF-16. Force UTF-8
# on both the read and the write side so the log is plain readable UTF-8.
$logPath = Join-Path $root "logs\refresh-loop.log"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Write-Log([string]$text) {
  [System.IO.File]::AppendAllText($logPath, $text + [Environment]::NewLine, $utf8)
}

# single-instance guard. Logged, not Write-Host: the task now runs under a hidden
# window (run-hidden.vbs), so console output goes nowhere and a silent bail would
# look identical to a silent death.
#
# GUARD ON THIS LAUNCHER, NOT ON THE NODE CHILD. The original check looked for a
# running refresh-loop.js and bailed if it found one, which has a 30-second hole:
# the supervise loop below sleeps 30s between node exiting and being restarted, so
# a second launcher starting in that window sees no node, passes, and we end up
# with TWO launchers each supervising their own daemon - both writing public/data
# and both running wrangler deploy. Measured 2026-08-28: launchers from 20:23:59
# and 00:13:21 alive together for ~4 hours, and killing both node children brought
# back two, one per launcher.
#
# A named mutex is the race-free form: the OS releases it when the owning process
# dies, so there is no stale lock to clean up. Global scope is required because the
# launcher can start from a logon (session 1) or a scheduled task (session 0), and
# a session-local mutex would not be shared between them.
$script:singleton = $null
$haveLock = $false
$guard = "mutex"
try {
  $script:singleton = New-Object System.Threading.Mutex($false, "Global\PadelTickerRefreshLoop")
  try { $haveLock = $script:singleton.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $haveLock = $true }
} catch {
  # A global mutex needs SeCreateGlobalPrivilege. This task runs as Dansk at
  # RunLevel=Limited (a UAC-filtered token), so it may not be available - never let
  # that take the daemon down. Fall back to looking for another launcher PROCESS,
  # which still closes the 30-second hole because it watches THIS script, not the
  # child.
  $script:singleton = $null
  $guard = "process-scan"
  $me = $PID
  $other = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*run-refresh-loop.ps1*' }
  $haveLock = -not $other
}
if (-not $haveLock) {
  Write-Log "[$([DateTime]::UtcNow.ToString('o'))] launcher bailed: another launcher holds the $guard guard"
  return
}
Write-Log "[$([DateTime]::UtcNow.ToString('o'))] launcher starting (PID $PID, $guard guard acquired)"

# Belt and braces, and why this check is KEPT rather than replaced: it also catches
# a refresh-loop.js someone started by hand, which holds no launcher lock.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*refresh-loop.js*' }
if ($running) {
  Write-Log "[$([DateTime]::UtcNow.ToString('o'))] launcher bailed: refresh-loop already running (PID $($running.ProcessId -join ','))"
  return
}

# loads $env:CLOUDFLARE_API_TOKEN + $env:CLOUDFLARE_ACCOUNT_ID (Pages token)
. (Join-Path $root "..\danskepadelklip-site\deploy.config.ps1")
Set-Location $root

# Supervise, don't just launch. The daemon died silently on 2026-07-21 (log ends
# mid-sleep at 09:27Z with no error) and nothing revived it for ~27h, so
# /api/health's dead-man's switch reported the site down while every source was
# fine. If node ever exits (crash, OOM, killed), restart it after a short pause
# instead of letting this launcher exit. A reboot/logon is still covered by
# PadelTicker-Refresh.vbs in shell:startup; scripts/install-refresh-task.ps1 adds
# the last layer (a 15-min revive tick) but needs an elevated shell to register.
while ($true) {
  & "C:\Program Files\nodejs\node.exe" scripts\refresh-loop.js 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Log $_.Exception.Message }
    else { Write-Log ([string]$_) }
  }
  Write-Log "[$([DateTime]::UtcNow.ToString('o'))] refresh-loop exited (code $LASTEXITCODE), restarting in 30s"
  Start-Sleep -Seconds 30
}
