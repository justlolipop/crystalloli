# Used by launch-studio.bat when Crystal Studio already runs on this PC: is a newer one online?
# Exit code 3: yes (the running one is then stopped, updated and started again). 0: no, or offline.
try {
  $here = (Select-String -Path (Join-Path $PSScriptRoot 'server.js') -Pattern 'const BUILD = "([^"]+)"').Matches[0].Groups[1].Value
  $online = (Invoke-WebRequest 'https://raw.githubusercontent.com/justlolipop/crystalloli/main/server.js' -UseBasicParsing -TimeoutSec 8).Content
  if ($online -match 'const BUILD = "([^"]+)"' -and $Matches[1] -ne $here) { exit 3 }
} catch { }
exit 0
