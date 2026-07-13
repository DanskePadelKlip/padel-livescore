# Launcher for the adaptive PadelTicker refresh daemon (fetch -> deploy ->
# adaptive sleep). Use this on an ALWAYS-ON, browser-capable box (a VPS, or a PC
# where `npx playwright install chromium` was run natively) — NOT via a scheduled
# task on the MSIX-sandboxed dev machine, where Playwright's browser isn't visible
# to native tasks. For hosted auto-refresh, use the GitHub Actions workflow
# (.github/workflows/refresh.yml) instead.
$ErrorActionPreference = "Continue"
# make node/npx resolvable even under a reduced scheduled-task PATH
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
# loads $env:CLOUDFLARE_API_TOKEN + $env:CLOUDFLARE_ACCOUNT_ID (Pages token)
. "C:\Users\Kimkr\AI Projects\danskepadelklip-site\deploy.config.ps1"
Set-Location "C:\Users\Kimkr\AI Projects\padel-livescore"
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
& "C:\Program Files\nodejs\node.exe" scripts/refresh-loop.js *>> "logs\refresh-loop.log"
