# Rebuild, restart the TEST browser, install the extension over CDP and verify.
#
# Chrome serves an unpacked extension from the registration it made when the
# profile was created, so a rebuild needs a fresh browser: launch-chrome.ps1
# allocates a new profile directory every run for exactly this reason.
#
# Only this harness's browser is stopped. The user's own Chrome session must
# never be touched, so nothing here matches on the image name.
#
# Usage: powershell -ExecutionPolicy Bypass -File test/run-e2e.ps1 [-Suite all]

param(
  [ValidateSet('all', 'hover', 'pages', 'errors', 'interactions')]
  [string]$Suite = 'all'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Write-Host '› building dist/'
Push-Location $root
bun build.mjs
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }

Write-Host '› stopping the test browser (the user''s Chrome is left alone)'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'lens-chrome-' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Write-Host '› starting a fresh test browser on :9222'
& (Join-Path $PSScriptRoot 'launch-chrome.ps1') | Out-Null
Start-Sleep -Seconds 8

$suites = switch ($Suite) {
  'all' { @('test/verify.mjs', 'test/check-pages.mjs', 'test/verify-ui-errors.mjs', 'test/verify-interactions.mjs') }
  'hover' { @('test/verify.mjs') }
  'pages' { @('test/check-pages.mjs') }
  'errors' { @('test/verify-ui-errors.mjs') }
  'interactions' { @('test/verify-interactions.mjs') }
}

$failed = $false
foreach ($spec in $suites) {
  Write-Host "› $spec"
  bun $spec
  if ($LASTEXITCODE -ne 0) { $failed = $true }
}

Pop-Location
if ($failed) { exit 1 }
exit 0
