$ErrorActionPreference = 'Continue'

$taskName = 'FortyTwoEventDashboard'
$project = 'C:\Users\Administrator\fortytwo-new-event-monitor'
$runner = Join-Path $project 'run-dashboard.ps1'

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""

$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 8

Write-Output '---TASK---'
Get-ScheduledTask -TaskName $taskName | Format-List TaskName,State,TaskPath | Out-String | Write-Output
Get-ScheduledTaskInfo -TaskName $taskName | Format-List LastRunTime,LastTaskResult,NextRunTime | Out-String | Write-Output

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
Get-Content -LiteralPath (Join-Path $project 'dashboard.log') -Tail 20
