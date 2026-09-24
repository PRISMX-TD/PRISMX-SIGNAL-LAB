#Requires -Version 3
<#
    一键重启 PRISMX MT5 Gateway,并打开实时日志。

    用法:双击同目录的 Restart-Gateway.cmd(会自动请求管理员权限)。
    也可以在管理员 PowerShell 里直接运行:  .\restart-gateway.ps1

    做的事,按顺序:
      1. 停止旧进程并禁用计划任务(install-service.ps1 -Stop)
      2. 有 .cs 比 mt5gateway.exe 新时自动重新编译(build.ps1);编译失败就用旧的 exe 继续启动,不会让网关停着
      3. 启用计划任务并启动,等健康检查通过(install-service.ps1 -Start)
      4. 显示 /health,然后实时滚动今天的日志。关掉这个窗口不影响网关运行

    参数:
      -NoBuild   跳过编译,只重启
      -Yes       不询问确认,直接执行
#>
param(
    [switch]$NoBuild,
    [switch]$Yes
)

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot

# ---- 需要管理员权限:不是的话,以管理员身份重新打开自己 ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($NoBuild) { $argList += "-NoBuild" }
    if ($Yes)     { $argList += "-Yes" }
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit
}

$Host.UI.RawUI.WindowTitle = "PRISMX Gateway - 重启与日志"
Set-Location $here

function Step($msg) { Write-Host "`n==== $msg ====" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Bad($msg)  { Write-Host "  [XX] $msg" -ForegroundColor Red }

function Pause-Exit($code) {
    Write-Host ""
    Read-Host "按回车关闭窗口"
    exit $code
}

Write-Host ""
Write-Host "PRISMX MT5 Gateway 一键重启" -ForegroundColor White
Write-Host "目录:$here"
Write-Host ""
Write-Host "注意:重启期间(通常 10~30 秒)网关账户无法下单平仓。" -ForegroundColor Yellow

if (-not $Yes) {
    $answer = Read-Host "确定要重启吗?输入 y 回车继续,直接回车取消"
    if ($answer -ne "y" -and $answer -ne "Y") {
        Write-Host "已取消,什么都没做。"
        Pause-Exit 0
    }
}

$service = Join-Path $here "install-service.ps1"
$build   = Join-Path $here "build.ps1"
$exe     = Join-Path $here "mt5gateway.exe"

if (-not (Test-Path $service)) {
    Bad "找不到 install-service.ps1,请把本脚本放在 gateway 文件夹里。"
    Pause-Exit 1
}

# ---- 1. 停止 ----
Step "1/4 停止旧进程"
& powershell -NoProfile -ExecutionPolicy Bypass -File $service -Stop
if ($LASTEXITCODE -ne 0) {
    Bad "停止失败(见上面的输出)。为安全起见不继续编译,直接尝试把网关启动回来。"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $service -Start
    Pause-Exit 1
}

# ---- 2. 需要时编译 ----
Step "2/4 检查是否需要编译"
$needBuild = $false

if ($NoBuild) {
    Ok "指定了 -NoBuild,跳过编译"
} elseif (-not (Test-Path $exe)) {
    Warn "没有 mt5gateway.exe,需要编译"
    $needBuild = $true
} else {
    $exeTime = (Get-Item $exe).LastWriteTime
    $newer = Get-ChildItem -Path $here -Filter *.cs | Where-Object { $_.LastWriteTime -gt $exeTime }
    if ($newer) {
        Warn ("这些源文件比 exe 新,需要编译:" + (($newer | ForEach-Object { $_.Name }) -join ", "))
        $needBuild = $true
    } else {
        Ok "源文件没有变化,不用编译"
    }
}

if ($needBuild) {
    if (Test-Path $exe) {
        $backup = "$exe.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $exe $backup
        Ok "已备份旧 exe:$(Split-Path $backup -Leaf)"
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $build
    if ($LASTEXITCODE -ne 0) {
        Bad "编译失败(见上面的红字)。继续用旧的 exe 启动,网关不会停着。"
        Bad "修好源文件后再运行一次本脚本即可。"
    } else {
        Ok "编译完成"
    }
}

# ---- 3. 启动 ----
Step "3/4 启动并等待健康检查"
& powershell -NoProfile -ExecutionPolicy Bypass -File $service -Start
$startOk = ($LASTEXITCODE -eq 0)

if (-not $startOk) {
    Bad "启动后健康检查没通过,下面看一下状态和日志找原因。"
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $service -Status

# ---- 4. 健康检查 + 实时日志 ----
Step "4/4 当前状态"
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:8800/health" -TimeoutSec 5
    $line = "  MT5 连接={0}  下单通道={1}  查询通道={2}/{3}" -f `
        $h.mt5Connected, $h.dealerActive, $h.readChannelsConnected, $h.readChannels
    if ($h.mt5Connected -and $h.dealerActive) {
        Write-Host $line -ForegroundColor Green
    } else {
        Write-Host $line -ForegroundColor Red
    }
    if ($h.readChannels -and $h.readChannelsConnected -lt $h.readChannels) {
        Warn "查询通道没有全部连上,查询会暂时走交易连接(功能正常),后台会自动重连。"
    }
} catch {
    Bad "健康检查无响应:$($_.Exception.Message)"
}

$logFile = Join-Path $here ("logs\gateway-{0}.log" -f (Get-Date -Format yyyyMMdd))

Write-Host ""
Write-Host "==== 实时日志(Ctrl+C 或直接关窗口即可退出,网关继续在后台运行) ====" -ForegroundColor Cyan
Write-Host "文件:$logFile"
Write-Host "提示:这个窗口随便点、随便关都不影响网关。过了午夜要看新一天的日志,重新双击一次即可。" -ForegroundColor DarkGray
Write-Host ""

if (-not (Test-Path $logFile)) {
    Warn "今天的日志文件还没生成,等它出现..."
    for ($i = 0; $i -lt 30 -and -not (Test-Path $logFile); $i++) { Start-Sleep -Seconds 1 }
}

if (Test-Path $logFile) {
    Get-Content $logFile -Wait -Tail 40 -Encoding UTF8
} else {
    Bad "30 秒内没看到日志文件,网关可能没启动起来。"
    Pause-Exit 1
}
