$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath 'C:\Users\Administrator\fortytwo-new-event-monitor'

while ($true) {
  try {
    node .\server.mjs *> .\dashboard.log
  } catch {
    Add-Content -LiteralPath .\dashboard.log -Value "[$(Get-Date -Format o)] runner error: $($_ | Out-String)"
  }

  Start-Sleep -Seconds 10
}
