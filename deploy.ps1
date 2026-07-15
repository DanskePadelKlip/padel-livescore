# Publishes public/ + functions/ to the padel-livescore (padelticker.com) Cloudflare
# Pages project via Wrangler. Mirrors danskepadelklip-site/deploy.ps1 and reuses the
# same git-ignored token file (deploy.config.ps1) so both sites share one Pages token.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg  = Join-Path $root "..\danskepadelklip-site\deploy.config.ps1"
if (-not (Test-Path $cfg)) {
  Write-Host "Missing $cfg - copy danskepadelklip-site/deploy.config.example.ps1 and fill it in." -ForegroundColor Yellow
  exit 1
}
. $cfg
if (-not $env:CLOUDFLARE_API_TOKEN -or -not $env:CLOUDFLARE_ACCOUNT_ID) {
  Write-Host "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set (check deploy.config.ps1)." -ForegroundColor Yellow
  exit 1
}
$ProjectName = "padel-livescore"

# Run from $root so Wrangler bundles the functions/ dir (the /api/* Pages Functions)
# alongside public/.
Set-Location $root
Write-Host "Deploying public/ + functions/ to Cloudflare Pages project '$ProjectName'..." -ForegroundColor Cyan
& npx --yes wrangler@4 pages deploy public --project-name=$ProjectName --branch main --commit-dirty=true
if ($LASTEXITCODE -ne 0) { Write-Host "Deploy FAILED (exit $LASTEXITCODE)." -ForegroundColor Red; exit $LASTEXITCODE }
Write-Host "Done." -ForegroundColor Green
