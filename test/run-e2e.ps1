# Rebuild, restart Chrome and run the end-to-end check.
#
# Chrome does not reload an unpacked extension when files change, so a rebuild
# always needs a fresh browser: the profile is wiped and the extension is
# installed again over CDP by test/verify.mjs.
#
# Usage: powershell -ExecutionPolicy Bypass -File test/run-e2e.ps1

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$profile = Join-Path $env:TEMP 'lens-chrome-profile'

Write-Host '› building dist/'
Push-Location $root
bun build.mjs
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }

Write-Host '› stopping any running Chrome'
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue

Write-Host '› starting Chrome on :9222'
& (Join-Path $PSScriptRoot 'launch-chrome.ps1') | Out-Null
Start-Sleep -Seconds 8

Write-Host '› verifying'
bun test/verify.mjs
$code = $LASTEXITCODE
Pop-Location
exit $code
