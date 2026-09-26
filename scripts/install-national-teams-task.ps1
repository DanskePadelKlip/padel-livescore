# Registers PadelTicker-NationalTeams-Weekly. RUN THIS ON THE LAPTOP (LEGION_AI),
# FROM AN ELEVATED POWERSHELL - task registration is denied at normal integrity.
#
# ASCII ONLY IN THIS FILE, same reason as install-refresh-task.ps1: PowerShell 5.1
# reads .ps1 as ANSI and a UTF-8 dash decodes into a smart quote that terminates a
# string early.
#
# What it schedules: scripts\refresh-national-teams.ps1, weekly, Monday 05:00. The
# job re-fetches the FIP national-team editions, rebuilds the two data files under
# --check, reports any new championship on the calendar without adding it, and
# commits + pushes only when something changed. The refresh daemon deploys the
# working tree on its next cycle, so there is nothing else to trigger.
#
# Why Monday 05:00: championships finish over a weekend, the box is idle then, and
# it lands before Kim looks at anything on Monday.
#
# Why Interactive, like the refresh daemon: the push needs Dansk's own GitHub
# credential, and Git Credential Manager's store is DPAPI-bound to Dansk. A task
# running as another account (or S4U with no password behind it) fails with
# "could not read Username for https://github.com" - which looks like a git bug and
# is an identity problem. The laptop is always logged on as Dansk, which is what
# the whole PadelTicker stack already assumes.

# -RunAsUser overrides who the task runs as. The DEFAULT IS THE MACHINE'S
# INTERACTIVE USER, not whoever is running this script, and that distinction is the
# whole reason this parameter exists: run from a remoting session the invoking
# account is Legion_AI\svc-remote, which is never logged on - so the task would
# register happily, never fire, and could not push if it did (Git Credential
# Manager's store is DPAPI-bound to Dansk).
param(
  [string]$RunAsUser
)

$ErrorActionPreference = "Stop"

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

$name   = "PadelTicker-NationalTeams-Weekly"
$script = "C:\Users\Dansk\AI Projects\padel-livescore\scripts\refresh-national-teams.ps1"
if (-not (Test-Path $script)) { throw "job not found: $script  (is this the laptop checkout, and is it up to date?)" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 5:00am

# StartWhenAvailable so a missed Monday (laptop asleep, reboot) runs late rather
# than being skipped - see the scheduler-skipping-days lesson. One hour is far more
# than the ~2 minutes this takes; it exists so a hung fetch cannot sit forever.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)

if (-not $RunAsUser) {
  # Win32_ComputerSystem.UserName is the account logged on at the console - the one
  # an Interactive task actually runs under.
  $RunAsUser = (Get-CimInstance Win32_ComputerSystem).UserName
}
if (-not $RunAsUser) {
  throw "Could not determine the interactive user, and none was given. Log on at the console, or pass -RunAsUser 'LEGION_AI\Dansk'."
}
$me = "$env:USERDOMAIN\$env:USERNAME"
if ($RunAsUser -ne $me) {
  Write-Host "Registering the task to run as $RunAsUser (this shell is $me)." -ForegroundColor Yellow
}
$principal = New-ScheduledTaskPrincipal -UserId $RunAsUser `
  -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description "Weekly: re-fetch FIP national-team editions, rebuild national-teams.json + national-teams-matches.json under --check, report new championships without adding them, commit and push if changed. Exit 3 = a new championship needs a hand-checked label; exit 2 = the build refused and nothing shipped." | Out-Null

Write-Host "Registered $name (Mondays 05:00, as $RunAsUser)." -ForegroundColor Green
# Start-ScheduledTask on an Interactive task runs it in that user's session, so this
# first run is the only place the git push gets exercised as Dansk before Monday.
Write-Host "Running it once now to prove it works end to end (watch for exit 4 = push failed)..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 90

Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo |
  Select-Object TaskName, LastRunTime, LastTaskResult, NextRunTime | Format-List

# Verify by artifact, not by exit code: a task can report 0x0 having done nothing.
$log = "C:\Users\Dansk\AI Projects\padel-livescore\logs\national-teams-refresh.log"
if (Test-Path $log) {
  Write-Host "--- tail of $log" -ForegroundColor Cyan
  Get-Content $log -Tail 25
} else {
  Write-Host "NO LOG AT $log - the job did not get as far as writing one." -ForegroundColor Red
}
