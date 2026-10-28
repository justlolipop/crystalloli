# Used by launch-studio.bat when Crystal Studio already runs on this PC: is a newer one online?
# Exit code 3: yes (the running one is then stopped, updated and started again). 0: no, or offline.
# Only NEWER counts: GitHub can hand out a copy a few minutes old, and restarting for that would stop
# Crystal Studio on every click while it's making the .ai files.
try {
  $here = (Select-String -Path (Join-Path $PSScriptRoot 'server.js') -Pattern 'const BUILD = "([^"]+)"').Matches[0].Groups[1].Value
  $online = (Invoke-WebRequest 'https://raw.githubusercontent.com/justlolipop/crystalloli/main/server.js' -UseBasicParsing -TimeoutSec 8).Content
  if ($online -match 'const BUILD = "([^"]+)"' -and [string]::CompareOrdinal($Matches[1], $here) -gt 0) { exit 3 }
  # the editor itself (js/app.js VERSION) changes far more often than server.js: newer too
  $mine = (Select-String -Path (Join-Path $PSScriptRoot 'js\app.js') -Pattern 'const VERSION = "([^"]+)"').Matches[0].Groups[1].Value
  $web = (Invoke-WebRequest 'https://raw.githubusercontent.com/justlolipop/crystalloli/main/js/app.js' -UseBasicParsing -TimeoutSec 8).Content
  if ($web -match 'const VERSION = "([^"]+)"' -and [string]::CompareOrdinal($Matches[1], $mine) -gt 0) { exit 3 }
} catch { }
exit 0
