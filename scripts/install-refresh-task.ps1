# Registers PadelTicker-Refresh-Daemon - the last supervision layer for the refresh
# loop. RUN THIS FROM AN ELEVATED POWERSHELL (right-click -> Run as administrator);
# task registration is denied at normal integrity on this machine.
#
# ASCII ONLY IN THIS FILE. Windows PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8
# em-dash decodes to three chars whose last byte (0x94) is a smart closing quote -
# inside a string that terminates it early and the script fails to parse. Keep
# punctuation plain: hyphens, not dashes; straight quotes, not curly.
#
# Why this task exists: on 2026-07-21 the daemon's whole process tree vanished
# mid-sleep (log ends 09:27Z with a clean "next in 10m" and no error) and nothing
# brought it back for ~27h. /api/health's dead-man's switch then reported the site
# down even though every source was healthy. The layers now are:
#   1. run-refresh-loop.ps1 restarts node if node alone dies.
#   2. PadelTicker-Refresh.vbs (shell:startup) starts it at every logon.
#   3. THIS TASK ticks every 15 min and revives the loop if the whole tree is gone.
# The launcher's single-instance guard makes the tick a no-op while the loop is alive.
$ErrorActionPreference = "Stop"

# Self-elevate. Register-ScheduledTask fails with a bare "Access is denied" at
# normal integrity, which looks like a bug rather than a missing UAC prompt, and
# right-clicking "Run as administrator" silently does not always take (tell-tale:
# an elevated shell starts in C:\WINDOWS\system32, not your profile). So rather
# than trusting the caller's shell, check and relaunch ourselves.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Not elevated. Relaunching with a UAC prompt - click Yes." -ForegroundColor Yellow
  $a = '-NoProfile -ExecutionPolicy Bypass -NoExit -File "' + $PSCommandPath + '"'
  try {
    Start-Process powershell -Verb RunAs -ArgumentList $a
  } catch {
    Write-Host "UAC was declined or unavailable; the task was not registered." -ForegroundColor Red
  }
  return
}
Write-Host "Running elevated." -ForegroundColor Green

$name   = "PadelTicker-Refresh-Daemon"
$script = "C:\Users\Dansk\AI Projects\padel-livescore\scripts\run-refresh-loop.ps1"
if (-not (Test-Path $script)) { throw "launcher not found: $script" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

$tLogon = New-ScheduledTaskTrigger -AtLogOn
$tTick  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 15)

# ExecutionTimeLimit 0 = never kill it; this is a daemon, not a job.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

# Interactive: the loop drives Playwright, which needs the logged-on user session.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $tLogon, $tTick `
  -Settings $settings -Principal $principal `
  -Description "Keeps the PadelTicker refresh loop alive: 15-min revive tick plus start at logon. Launcher guards against duplicates." | Out-Null

Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 20
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo |
  Select-Object TaskName, LastRunTime, LastTaskResult | Format-List
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*refresh-loop.js*' }
# Verify by artifact, not exit code - a task can report 0x0 and still have done nothing.
if ($p) { "DAEMON RUNNING pid=$($p.ProcessId)" } else { "DAEMON NOT RUNNING - check logs\refresh-loop.log" }
