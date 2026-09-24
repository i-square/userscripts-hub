# 注册"登录时自动启动 Codex 登录态同步服务"计划任务（当前用户，隐藏窗口，无需管理员权限）
$ErrorActionPreference = 'Stop'

$taskName = 'CodexAuthSyncServer'
$serverJs = Join-Path $PSScriptRoot 'codex-auth-server.js'
if (-not (Test-Path $serverJs)) {
    Write-Host "[错误] 未找到 $serverJs" -ForegroundColor Red
    exit 1
}
$node = (Get-Command node -ErrorAction Stop).Source

# conhost --headless：以无窗口方式常驻 node 进程
$action  = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" `"$serverJs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'ChatGPT Codex 登录态同步微服务（userscripts-hub 油猴脚本配套）' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "[OK] 计划任务 '$taskName' 已注册并启动，登录系统后会自动运行" -ForegroundColor Green
Write-Host "配置文件: $(Join-Path $PSScriptRoot 'config.json')（首次启动自动生成，内含随机同步密钥）"
Write-Host "请把 config.json 中的 syncKey 填入油猴脚本面板的「同步密钥」设置！"