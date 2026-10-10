# Dev/test launcher: opens Chrome with CDP on :9222 so test/verify*.mjs can
# install dist/ through the Extensions domain.
#
# Two things this deliberately does:
#
#  * A FRESH profile directory every run. Chrome registers an unpacked extension
#    and keeps serving its scripts from that registration; reusing a profile
#    means the browser can run a stale copy of the extension after a rebuild.
#    Wiping is not enough on Windows, because a profile that was just closed
#    still has locked files, so each run gets its own directory.
#
#  * No --load-extension. Branded Chrome builds ignore it since Chrome 137, so
#    the extension is installed over CDP instead, which needs
#    --enable-unsafe-extension-debugging.
#
# Not part of the packaged extension.
param(
  [string]$Url = 'http://127.0.0.1:8123/test/demo.html',
  [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $env:TEMP ("lens-chrome-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

# Stop only browsers this harness started. NEVER `Stop-Process -Name chrome` or
# `taskkill /IM chrome.exe`: the user's own browser session is almost always
# running and is identified only by the absence of `lens-chrome-` in its
# command line.
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'lens-chrome-' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# Drop profiles from earlier runs. A locked one is left alone, which is fine now
# that it is never reused.
Get-ChildItem -Path $env:TEMP -Directory -Filter 'lens-chrome-*' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

Write-Host "profile: $profile"

$chromeArgs = @(
  "--user-data-dir=$profile"
  "--remote-debugging-port=$Port"
  '--remote-allow-origins=*'
  '--enable-unsafe-extension-debugging'
  '--no-first-run'
  '--no-default-browser-check'
  '--disable-sync'
  '--disable-features=Translate,MediaRouter'
  '--window-size=1200,760'
  $Url
)

$process = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -PassThru
Write-Host "chrome started (pid $($process.Id)) on :$Port; extension is installed by the verify scripts"
