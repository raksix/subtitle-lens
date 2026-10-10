# Dev/test launcher: opens Chrome with CDP on :9222 so test/verify.mjs can
# install dist/ through the Extensions domain.
#
# Branded Chrome builds ignore --load-extension since Chrome 137, so the
# extension is installed over CDP instead of a command-line switch. Requires
# --enable-unsafe-extension-debugging.
#
# Not part of the packaged extension.
$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $env:TEMP 'lens-chrome-profile'
$url = if ($args.Count -ge 1) { $args[0] } else { 'http://127.0.0.1:8123/test/demo.html' }

if (Test-Path $profile) { Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue }

$chromeArgs = @(
  "--user-data-dir=$profile"
  '--remote-debugging-port=9222'
  '--remote-allow-origins=*'
  '--enable-unsafe-extension-debugging'
  '--no-first-run'
  '--no-default-browser-check'
  '--window-size=1200,760'
  $url
)
Start-Process -FilePath $chrome -ArgumentList $chromeArgs
Write-Host 'chrome started on :9222 (extension is installed by test/verify.mjs)'
