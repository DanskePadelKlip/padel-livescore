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
# single-instance guard: if a refresh-loop daemon is already running (re-logon,
# a manual start, the Startup launcher firing twice), bail so we never run two
# daemons deploying on top of each other.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*refresh-loop.js*' }
if ($running) { Write-Host "refresh-loop already running (PID $($running.ProcessId -join ','))"; return }
# Machine-agnostic: derive the repo root from THIS script's location (scripts/ ->
# repo root) so the launcher works on whichever box is the always-on host, not a
# hardcoded user profile. Was pinned to C:\Users\Kimkr (old desktop); the always-on
# role now lives on the laptop.
$root = Split-Path -Parent $PSScriptRoot
# loads $env:CLOUDFLARE_API_TOKEN + $env:CLOUDFLARE_ACCOUNT_ID (Pages token)
. (Join-Path $root "..\danskepadelklip-site\deploy.config.ps1")
Set-Location $root
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
# Supervise, don't just launch. The daemon died silently on 2026-07-21 (log ends
# mid-sleep at 09:27Z with no error) and nothing revived it for ~27h, so
# /api/health's dead-man's switch reported the site down while every source was
# fine. If node ever exits (crash, OOM, killed), restart it after a short pause
# instead of letting this launcher exit. A reboot/logon is still covered by
# PadelTicker-Refresh.vbs in shell:startup; scripts/install-refresh-task.ps1 adds
# the last layer (a 15-min revive tick) but needs an elevated shell to register.
while ($true) {
  & "C:\Program Files\nodejs\node.exe" scripts/refresh-loop.js *>> "logs\refresh-loop.log"
  "[$([DateTime]::UtcNow.ToString('o'))] refresh-loop exited (code $LASTEXITCODE), restarting in 30s" *>> "logs\refresh-loop.log"
  Start-Sleep -Seconds 30
}
