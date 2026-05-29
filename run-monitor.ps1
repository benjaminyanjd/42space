$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath 'C:\Users\Administrator\fortytwo-new-event-monitor'

while ($true) {
  try {
    node .\monitor-42-events.mjs *> .\monitor.log
  } catch {
    Add-Content -LiteralPath .\monitor.log -Value "[$(Get-Date -Format o)] runner error: $($_ | Out-String)"
  }

  Start-Sleep -Seconds 10
}
