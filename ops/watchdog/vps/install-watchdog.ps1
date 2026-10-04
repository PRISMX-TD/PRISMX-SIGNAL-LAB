#Requires -Version 3
<#
    安装 / 管理 PRISMX gateway 看门狗(计划任务 PRISMX-Watchdog,以 SYSTEM 常驻)。

    用法(管理员 PowerShell,在本脚本所在目录):
        .\install-watchdog.ps1              安装(或更新)并启动
        .\install-watchdog.ps1 -Restart     改了 watchdog.ini / watchdog.ps1 后重启看门狗
        .\install-watchdog.ps1 -Status      看状态和最近的看门狗日志
        .\install-watchdog.ps1 -Uninstall   卸载(不影响 gateway 本身)

    建议放在 gateway 目录旁边的独立文件夹,例如 C:\Users\Administrator\Desktop\watchdog,
    不要放进 gateway 目录:gateway 目录的 build.ps1 / restart 流程与它无关。
#>
[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$Status,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "PRISMX-Watchdog"
$here = $PSScriptRoot
$Script = Join-Path $here "watchdog.ps1"
$Ini = Join-Path $here "watchdog.ini"

function Write-Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   [OK] $msg" -ForegroundColor Green }
function Write-Bad($msg)  { Write-Host "   [!!] $msg" -ForegroundColor Red }
function Write-Note($msg) { Write-Host "   $msg" -ForegroundColor DarkGray }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Bad "请用管理员身份打开 PowerShell 再运行。"
    exit 1
}

# 停掉正在跑的看门狗:计划任务实例 + 任何在跑 watchdog.ps1 的 powershell 进程
function Stop-Watchdog {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { [string]$_.CommandLine -match 'watchdog\.ps1' -and [string]$_.CommandLine -notmatch 'install-watchdog\.ps1' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Show-Status {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Bad "看门狗计划任务没安装"; return }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Note "计划任务 : $($t.State)(上次运行 $($info.LastRunTime))"
    if ($t.State -eq "Disabled") { Write-Bad "看门狗任务被禁用了,执行 .\install-watchdog.ps1 -Restart" }
    $running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { [string]$_.CommandLine -match '\\watchdog\.ps1' }
    if ($running) { Write-Ok "看门狗进程在运行(PID $(@($running)[0].ProcessId))" } else { Write-Bad "看门狗进程没在运行" }
    $log = Get-ChildItem (Join-Path $here "logs") -Filter "watchdog-*.log" -ErrorAction SilentlyContinue |
        Sort-Object Name | Select-Object -Last 1
    if ($log) {
        Write-Step "最近的看门狗日志($($log.Name))"
        Get-Content $log.FullName -Tail 20 -Encoding UTF8
    }
}

if ($Status) { Show-Status; exit 0 }

if ($Uninstall) {
    Write-Step "卸载看门狗"
    Stop-Watchdog
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Ok "已卸载。gateway 本身不受影响;watchdog.ini 与 logs\ 保留在原处。"
    exit 0
}

if ($Restart) {
    Write-Step "重启看门狗"
    Stop-Watchdog
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Show-Status
    exit 0
}

# ---------------------------------------------------------------- 安装

if (-not (Test-Path $Script)) { Write-Bad "找不到 $Script"; exit 1 }

Write-Step "配置文件"
if (Test-Path $Ini) {
    Write-Ok "watchdog.ini 已存在,保留不动"
} else {
    Copy-Item (Join-Path $here "watchdog.ini.example") $Ini
    Write-Ok "已从 watchdog.ini.example 生成 watchdog.ini(通知默认关闭)"
}
# watchdog.ini 里会放 Resend 密钥和 Telegram token:只留 SYSTEM 与 Administrators
& icacls.exe $Ini /inheritance:r /grant:r "SYSTEM:(F)" "Administrators:(F)" | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Ok "已收紧 watchdog.ini 权限(仅 SYSTEM / Administrators)" }
else { Write-Bad "icacls 返回 $LASTEXITCODE,请手工核对 watchdog.ini 的权限" }

Write-Step "试查一轮(只打印,不重启、不发通知)"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script -Once

Write-Step "创建计划任务 $TaskName"
Stop-Watchdog
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Note "删除了同名的旧任务"
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`"" `
    -WorkingDirectory $here
# 开机启动 + 每 5 分钟兜底触发一次(已在跑就忽略),看门狗自己挂了也会被拉起来。
# 重复时长必须显式给,不给时不同 Windows 版本的默认值不一致(见 gateway 的 install-service.ps1)。
# 但不能用 [TimeSpan]::MaxValue:它序列化成 P99999999DT23H59M59S,这台 VPS 的任务计划程序
# 直接拒收("任务 XML 包含格式不正确或超出范围的值")。给 10 年,实际等于永远,并且每台都认。
# Not [TimeSpan]::MaxValue: it serialises to P99999999DT23H59M59S, which Task
# Scheduler on the VPS rejects as out of range. Ten years is forever in practice.
$trigAtStartup = New-ScheduledTaskTrigger -AtStartup
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# Register-ScheduledTask 失败时抛的是非终止错误,$ErrorActionPreference 拦不住,
# 以前会照样打出"已创建"。显式 -ErrorAction Stop,并回读一次确认任务真的在。
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigAtStartup, $trigRepeat) `
        -Principal $principal -Settings $settings `
        -Description "PRISMX gateway 看门狗:gateway 卡死/没起来时自动处理,其他异常发通知" `
        -ErrorAction Stop | Out-Null
} catch {
    Write-Bad "创建计划任务失败:$($_.Exception.Message)"
    exit 1
}
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Bad "创建计划任务后读不到它,安装没有完成"
    exit 1
}
Write-Ok "计划任务已创建"

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
Show-Status

Write-Host ""
Write-Host "完成。以后:" -ForegroundColor Cyan
Write-Note "看状态      .\install-watchdog.ps1 -Status"
Write-Note "改配置后    .\install-watchdog.ps1 -Restart"
Write-Note "测试通知    .\watchdog.ps1 -TestAlert(要先在 watchdog.ini 打开渠道)"
