$ErrorActionPreference = 'Continue'

schtasks /End /TN FortyTwoEventMonitor | Out-Null
schtasks /Delete /TN FortyTwoEventMonitor /F | Out-Null

$taskRun = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\Administrator\fortytwo-new-event-monitor\run-monitor.ps1'
schtasks /Create /F /TN FortyTwoEventMonitor /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $taskRun
schtasks /Run /TN FortyTwoEventMonitor

Start-Sleep -Seconds 8

Write-Output '---TASK---'
schtasks /Query /TN FortyTwoEventMonitor /V /FO LIST |
  Select-String -Pattern 'TaskName|Status|Task To Run|Last Run Time|Last Result' |
  ForEach-Object { $_.Line }

Write-Output '---NODE PROCS---'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*monitor-42-events.mjs*' } |
  Select-Object ProcessId, CommandLine |
  Format-List |
  Out-String |
  Write-Output

Write-Output '---LOG---'
Get-Content -LiteralPath 'C:\Users\Administrator\fortytwo-new-event-monitor\monitor.log' -Tail 20
