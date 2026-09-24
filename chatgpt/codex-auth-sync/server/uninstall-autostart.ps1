# 移除 Codex 登录态同步服务的登录自启计划任务
$taskName = 'CodexAuthSyncServer'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[OK] 计划任务 '$taskName' 已移除（config.json / 日志文件保留，可手动删除）" -ForegroundColor Green