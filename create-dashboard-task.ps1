$ErrorActionPreference = 'Continue'

schtasks /End /TN FortyTwoEventDashboard | Out-Null
schtasks /Delete /TN FortyTwoEventDashboard /F | Out-Null

$taskRun = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\Administrator\fortytwo-new-event-monitor\run-dashboard.ps1'
schtasks /Create /F /TN FortyTwoEventDashboard /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $taskRun
schtasks /Run /TN FortyTwoEventDashboard

Start-Sleep -Seconds 8

Write-Output '---TASK---'
schtasks /Query /TN FortyTwoEventDashboard /V /FO LIST |
  Select-String -Pattern 'TaskName|Status|Task To Run|Last Run Time|Last Result' |
  ForEach-Object { $_.Line }

Write-Output '---NODE PROCS---'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.mjs*' } |
  Select-Object ProcessId, CommandLine |
  Format-List |
  Out-String |
  Write-Output

Write-Output '---HEALTH---'
Invoke-RestMethod -Uri 'http://127.0.0.1:4242/api/health' -TimeoutSec 10 |
  ConvertTo-Json -Depth 5 |
  Write-Output

Write-Output '---LOG---'
Get-Content -LiteralPath 'C:\Users\Administrator\fortytwo-new-event-monitor\dashboard.log' -Tail 20
