#Requires -Version 3
<#
    把 mt5gateway.exe 装成开机自启、不依赖登录会话的后台任务。

    解决的问题:gateway 现在跑在远程桌面的前台窗口里,RDP 一断线或机器一重启
    就死,所有 Gateway 直连用户集体掉线,得人工远程进去重新敲命令。

    为什么用任务计划程序而不是 nssm:
      · 不需要下载任何第三方程序到这台跑着 MT5 管理员连接的机器上
      · Windows 自带,零信任成本
      · 开机自启、不依赖登录、崩溃自愈这三件事它都能做

    唯一不如 nssm 的地方是崩溃后的恢复速度(最快约 2 分钟,nssm 是秒级)。
    但本次要治的主症是"RDP 断线/重启就死",这一点两者完全等效。

    用法(必须用管理员身份打开 PowerShell):
        .\install-service.ps1              安装并启动
        .\install-service.ps1 -Status      只看状态,不改任何东西
        .\install-service.ps1 -Uninstall   卸载,回到手工前台运行

    安装后验证方式见脚本结尾的输出。
#>

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

$TaskName = "PRISMX-Gateway"
$ExeName  = "mt5gateway.exe"

# ---------------------------------------------------------------- helpers

function Write-Step($msg)  { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "   [OK] $msg" -ForegroundColor Green }
function Write-Bad($msg)   { Write-Host "   [!!] $msg" -ForegroundColor Red }
function Write-Note($msg)  { Write-Host "   $msg" -ForegroundColor DarkGray }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 从 gateway.ini 里读监听端口,读不到就按默认 8800。
# 注意 Config.cs 是忽略 [section] 的,所以这里也只按 key 匹配。
function Get-ListenPort($iniPath) {
    if (-not (Test-Path $iniPath)) { return 8800 }
    foreach ($line in [System.IO.File]::ReadAllLines($iniPath)) {
        $t = $line.Trim()
        if ($t.StartsWith("#") -or $t.StartsWith(";")) { continue }
        if ($t -match '^\s*listen\s*=\s*(.+?)\s*$') {
            if ($matches[1] -match ':(\d+)') { return [int]$matches[1] }
        }
    }
    return 8800
}

function Test-Health($port) {
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Encoding = [System.Text.Encoding]::UTF8
        return $wc.DownloadString("http://127.0.0.1:$port/health")
    } catch {
        return $null
    }
}

# ---------------------------------------------------------------- paths

$GatewayDir = $PSScriptRoot
$ExePath    = Join-Path $GatewayDir $ExeName
$IniPath    = Join-Path $GatewayDir "gateway.ini"
$Port       = Get-ListenPort $IniPath

# ---------------------------------------------------------------- status

if ($Status) {
    Write-Step "当前状态"
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Note "计划任务      : 已安装,State=$($task.State) LastResult=$($info.LastTaskResult)"
        Write-Note "上次运行      : $($info.LastRunTime)"
    } else {
        Write-Note "计划任务      : 未安装"
    }
    $proc = Get-Process -Name ($ExeName -replace '\.exe$','') -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Note "进程          : 运行中 (PID $($proc.Id -join ','))"
    } else {
        Write-Note "进程          : 未运行"
    }
    $health = Test-Health $Port
    if ($health) { Write-Ok "健康检查      : $health" }
    else         { Write-Bad "健康检查      : 端口 $Port 无响应" }
    return
}

# ---------------------------------------------------------------- guards

if (-not (Test-Admin)) {
    Write-Bad "需要管理员权限。请右键 PowerShell -> 以管理员身份运行,再执行本脚本。"
    exit 1
}

if ($Uninstall) {
    Write-Step "卸载计划任务"
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Ok "计划任务已删除"
    } else {
        Write-Note "计划任务本来就不存在"
    }
    Get-Process -Name ($ExeName -replace '\.exe$','') -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Note "进程已停止。回到手工模式请执行:  .\$ExeName serve"
    return
}

Write-Step "检查前置条件"

if (-not (Test-Path $ExePath)) {
    Write-Bad "找不到 $ExePath。请先执行 .\build.ps1 编译。"
    exit 1
}
Write-Ok "找到 $ExeName"

if (-not (Test-Path $IniPath)) {
    Write-Bad "找不到 gateway.ini。这是配置文件,没有它 gateway 起不来。"
    exit 1
}
Write-Ok "找到 gateway.ini,监听端口 $Port"

# 记录改造前的健康状态,便于最后对比
$before = Test-Health $Port
if ($before) { Write-Note "改造前健康检查: $before" }
else         { Write-Note "改造前:$Port 端口无响应(gateway 当前没在跑)" }

# ---------------------------------------------------------------- install

Write-Step "停止现有进程"
$running = Get-Process -Name ($ExeName -replace '\.exe$','') -ErrorAction SilentlyContinue
if ($running) {
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
    Write-Ok "已停止旧进程 (PID $($running.Id -join ','))"
    Write-Note "从现在起 Gateway 通道短暂离线,请尽快完成后续步骤"
} else {
    Write-Note "没有正在运行的进程"
}

Write-Step "创建计划任务"

# 已存在就先删掉,让本脚本可以反复执行而不出错
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Note "删除了同名的旧任务"
}

# WorkingDirectory 必须设成 gateway 目录:程序用相对路径找 gateway.ini 和
# bases\ 缓存目录,工作目录不对会直接起不来。这是最容易踩的坑。
$action = New-ScheduledTaskAction -Execute $ExePath -Argument "serve" -WorkingDirectory $GatewayDir

# 两个触发器,各管一件事:
#   1) 开机自启 —— 治"VPS 重启后不会自己起来"
#   2) 每 2 分钟重复 —— 看门狗。配合下面的 MultipleInstances=IgnoreNew,
#      进程还活着时新实例直接被忽略,不会起第二份;进程没了才真正拉起。
#      这一条让"进程因任何原因消失"都能在 2 分钟内自愈,不需要第三方工具。
$trigAtStartup = New-ScheduledTaskTrigger -AtStartup
$trigWatchdog  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
                    -RepetitionInterval (New-TimeSpan -Minutes 2)

# 以 SYSTEM 身份、最高权限运行 —— 这才是"不依赖任何人登录"的关键,
# 同时不需要在任务里存任何账号密码。
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# 这几个设置逐条都是必须的,默认值会让长驻程序出问题:
#   ExecutionTimeLimit 0        默认是 3 天,到点会把还在跑的任务杀掉(经典坑)
#   MultipleInstances IgnoreNew 看门狗触发时若已在跑,忽略新实例而不是起第二份
#   RestartCount/Interval       非正常退出时快速重试,比看门狗更快一档
#   DisallowStart/StopIfOnBatteries  VPS 无电池,但默认值在某些虚拟化下会误判
#   StartWhenAvailable          错过触发时间(如休眠恢复)也补跑
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName `
    -Action $action `
    -Trigger @($trigAtStartup, $trigWatchdog) `
    -Principal $principal `
    -Settings $settings `
    -Description "PRISMX MT5 Gateway - 开机自启,不依赖登录会话,进程消失后 2 分钟内自愈" | Out-Null

Write-Ok "计划任务 '$TaskName' 已创建"

Write-Step "启动"
Start-ScheduledTask -TaskName $TaskName

# ---------------------------------------------------------------- verify

Write-Step "验证(最多等 30 秒)"

$health = $null
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    $health = Test-Health $Port
    if ($health) { break }
}

$proc = Get-Process -Name ($ExeName -replace '\.exe$','') -ErrorAction SilentlyContinue
if ($proc) { Write-Ok "进程已启动 (PID $($proc.Id -join ','))" }
else       { Write-Bad "进程没起来" }

if ($health) {
    Write-Ok "健康检查通过: $health"
    if ($health -notmatch '"mt5Connected"\s*:\s*true') {
        Write-Bad "注意:mt5Connected 不是 true,gateway 起来了但没连上券商。看 logs\ 下当天日志。"
    }
} else {
    Write-Bad "健康检查失败:$Port 端口无响应"
    Write-Host ""
    Write-Host "排查:" -ForegroundColor Yellow
    Write-Host "  1. 看任务结果:  Get-ScheduledTaskInfo -TaskName $TaskName"
    Write-Host "  2. 看程序日志:  Get-Content logs\gateway-$(Get-Date -Format yyyyMMdd).log -Tail 40"
    Write-Host "  3. 应急回退(先恢复业务,再慢慢查):"
    Write-Host "       .\install-service.ps1 -Uninstall"
    Write-Host "       .\$ExeName serve"
    exit 1
}

# ---------------------------------------------------------------- done

Write-Host ""
Write-Host "================ 安装完成 ================" -ForegroundColor Green
Write-Host ""
Write-Host "接下来请务必做这一步(本次改造的真正目的):" -ForegroundColor Yellow
Write-Host "  直接关掉远程桌面窗口,等 5 分钟,再从后端 VPS 执行:"
Write-Host "      curl -m 5 http://150.109.22.166:8800/health"
Write-Host "  改造前这一步必然失败(进程随会话死),现在应该照常返回 JSON。"
Write-Host ""
Write-Host "日常命令:"
Write-Host "  查看状态:  .\install-service.ps1 -Status"
Write-Host "  停止:      Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  启动:      Start-ScheduledTask -TaskName $TaskName"
Write-Host "  卸载:      .\install-service.ps1 -Uninstall"
Write-Host ""
