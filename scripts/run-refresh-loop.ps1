# Launcher for the adaptive PadelTicker refresh daemon (fetch -> deploy ->
# adaptive sleep). Use this on an ALWAYS-ON, browser-capable box (a VPS, or a PC
# where `npx playwright install chromium` was run natively) — NOT via a scheduled
# task on the MSIX-sandboxed dev machine, where Playwright's browser isn't visible
# to native tasks. For hosted auto-refresh, use the GitHub Actions workflow
# (.github/workflows/refresh.yml) instead.
$ErrorActionPreference = "Continue"
# make node/npx resolvable even under a reduced scheduled-task PATH
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
# Machine-agnostic: derive the repo root from THIS script's location (scripts/ ->
# repo root) so the launcher works on whichever box is the always-on host, not a
# hardcoded user profile. Was pinned to C:\Users\Kimkr (old desktop); the always-on
# role now lives on the laptop.
$root = Split-Path -Parent $PSScriptRoot
# loads $env:CLOUDFLARE_API_TOKEN + $env:CLOUDFLARE_ACCOUNT_ID (Pages token)
. (Join-Path $root "..\danskepadelklip-site\deploy.config.ps1")
Set-Location $root
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
& "C:\Program Files\nodejs\node.exe" scripts/refresh-loop.js *>> "logs\refresh-loop.log"
