#Requires -Version 3
<#
    一键重启 PRISMX MT5 Gateway,并打开实时日志。

    用法:双击同目录的 Restart-Gateway.cmd(会自动请求管理员权限)。
    也可以在管理员 PowerShell 里直接运行:  .\restart-gateway.ps1

    做的事,按顺序:
      1. 有 .cs 比 mt5gateway.exe 新时,**趁旧进程还在跑**先编译到临时文件 mt5gateway.new.exe
         (build.ps1 -Out)。编译失败就到此为止:旧网关一秒都没停过,什么都没改
      2. 停止旧进程并禁用计划任务(install-service.ps1 -Stop)
      3. 编译过的话:备份旧 exe(mt5gateway.exe.bak-时间戳),换上新 exe
      4. 启用计划任务并启动(install-service.ps1 -Start),再做健康检查(/health,重试若干次)。
         换过 exe 而健康检查不过:自动还原备份、再启动一次,并明确报错
      5. 显示 /health,然后实时滚动今天的日志。关掉这个窗口不影响网关运行

    以前是先停服务再编译:编译那十几秒网关是停着的,编译失败还得靠旧 exe 起来;备份了旧
    exe 却从不用它——新 exe 起不来时只打一行提示,网关就停在那里。

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

# 从 gateway.ini 读监听地址,与 install-service.ps1 的 Get-ListenAddress 同一套规则:
# 读不到按 127.0.0.1:8800;`+` / `*` / `0.0.0.0` 在本机用 127.0.0.1 探活;写了具体 IP
# (比如 WireGuard 隧道的 10.66.0.2)就打那个 IP——网关只听隧道地址时 127.0.0.1 上没有它,
# 写死 127.0.0.1 会把好好的新版本误判成起不来,然后把它回滚掉。
function Get-ListenAddress($iniPath) {
    $listenHost = "127.0.0.1"; $port = 8800
    if (Test-Path $iniPath) {
        foreach ($line in [System.IO.File]::ReadAllLines($iniPath)) {
            $t = $line.Trim()
            if ($t.StartsWith("#") -or $t.StartsWith(";")) { continue }
            if ($t -match '^\s*listen\s*=\s*(.+?)\s*$') {
                $url = $matches[1]
                if ($url -match '://([^/:]+):(\d+)') {
                    $h = $matches[1]; $port = [int]$matches[2]
                    if ($h -ne "+" -and $h -ne "*" -and $h -ne "0.0.0.0") { $listenHost = $h }
                } elseif ($url -match ':(\d+)') { $port = [int]$matches[1] }
            }
        }
    }
    return "$($listenHost):$port"
}

# 打一次 /health,拿到 HTTP 200 就返回响应体,否则返回 $null。优先用系统自带的 curl.exe
# (Windows 10 1803 / Server 2019 起自带),没有就退回 WebClient。
# 只看"进程起来了、HTTP 在答话":mt5Connected=false 不算失败——那多半是券商那头的事,
# 回滚到旧版本也连不上,反而白白多停一次。
function Get-Health($listen) {
    $url = "http://$listen/health"
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        $body = & $curl.Source -s -f -m 5 $url 2>$null
        if ($LASTEXITCODE -eq 0 -and $body) { return ($body -join "") }
        return $null
    }
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Encoding = [System.Text.Encoding]::UTF8
        return $wc.DownloadString($url)
    } catch {
        return $null
    }
}

function Wait-Health($listen, $tries, $intervalSec) {
    for ($i = 1; $i -le $tries; $i++) {
        $h = Get-Health $listen
        if ($h) { return $h }
        Write-Host ("  健康检查第 {0}/{1} 次无响应,{2} 秒后重试..." -f $i, $tries, $intervalSec) -ForegroundColor DarkGray
        Start-Sleep -Seconds $intervalSec
    }
    return $null
}

Write-Host ""
Write-Host "PRISMX MT5 Gateway 一键重启" -ForegroundColor White
Write-Host "目录:$here"
Write-Host ""
Write-Host "注意:重启期间(通常 10~30 秒)网关账户无法下单平仓。需要编译时会先编译好再停,编译不占停机时间。" -ForegroundColor Yellow

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
$newExe  = Join-Path $here "mt5gateway.new.exe"
$listen  = Get-ListenAddress (Join-Path $here "gateway.ini")

if (-not (Test-Path $service)) {
    Bad "找不到 install-service.ps1,请把本脚本放在 gateway 文件夹里。"
    Pause-Exit 1
}

# ---- 1. 需要时先编译到临时文件(旧进程照常跑) ----
Step "1/5 检查是否需要编译"
$needBuild = $false
$haveNew = $false

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
    if (Test-Path $newExe) { Remove-Item $newExe -Force -ErrorAction SilentlyContinue }

    Write-Host "  网关还在运行,先编译到 $(Split-Path $newExe -Leaf) ..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File $build -Out $newExe
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $newExe)) {
        if (Test-Path $newExe) { Remove-Item $newExe -Force -ErrorAction SilentlyContinue }
        Bad "编译失败(见上面的红字)。旧网关没有停过,也没有做任何改动,一切照旧在运行。"
        Bad "修好源文件后再运行一次本脚本即可。"
        Pause-Exit 1
    }
    $haveNew = $true
    Ok "新版本已编译好,接下来才停服务"
}

# ---- 2. 停止 ----
Step "2/5 停止旧进程"
& powershell -NoProfile -ExecutionPolicy Bypass -File $service -Stop
if ($LASTEXITCODE -ne 0) {
    Bad "停止失败(见上面的输出)。为安全起见不替换 exe,直接尝试把网关启动回来。"
    if ($haveNew) { Remove-Item $newExe -Force -ErrorAction SilentlyContinue }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $service -Start
    Pause-Exit 1
}

# ---- 3. 换上新 exe(先备份) ----
Step "3/5 替换程序文件"
$backup = $null
$replaced = $false

if (-not $haveNew) {
    Ok "没有新编译的版本,沿用现有 mt5gateway.exe"
} else {
    try {
        if (Test-Path $exe) {
            $backup = "$exe.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
            Copy-Item $exe $backup -ErrorAction Stop
            Ok "已备份旧 exe:$(Split-Path $backup -Leaf)"
        }
        Move-Item $newExe $exe -Force -ErrorAction Stop
        $replaced = $true
        Ok "已换上新版本"
    } catch {
        Bad "替换 exe 失败:$($_.Exception.Message)"
        # Move-Item 失败时旧 exe 通常原封未动;万一被弄坏/弄没了,从备份拿回来。
        if ($backup -and (Test-Path $backup)) {
            try {
                Copy-Item $backup $exe -Force -ErrorAction Stop
                Warn "已从备份恢复旧 exe"
            } catch {
                Bad "从备份恢复也失败了:$($_.Exception.Message)。备份在:$backup"
            }
        }
        if (Test-Path $newExe) { Remove-Item $newExe -Force -ErrorAction SilentlyContinue }
        Bad "继续用旧版本启动。"
    }
}

# ---- 4. 启动 + 健康检查,失败自动回滚 ----
Step "4/5 启动并等待健康检查"
& powershell -NoProfile -ExecutionPolicy Bypass -File $service -Start
$startOk = ($LASTEXITCODE -eq 0)

# -Start 自己最多等 30 秒;新版本首次连券商、同步数据可能更久,这里再给它一段时间,
# 不要因为慢一点就把好好的新版本回滚掉。
$health = $null
if ($startOk) {
    $health = Get-Health $listen
}
if (-not $health) {
    Warn "启动后 $listen/health 暂时没有响应,继续等..."
    $health = Wait-Health $listen 10 3
}

$rolledBack = $false
$rollbackFailed = $false

if ($health) {
    Ok "健康检查通过($listen)"
} elseif ($replaced -and $backup -and (Test-Path $backup)) {
    Bad "新版本启动后健康检查一直不过,自动回滚到旧版本。"

    & powershell -NoProfile -ExecutionPolicy Bypass -File $service -Stop
    if ($LASTEXITCODE -ne 0) {
        Bad "回滚时停止失败,仍尝试覆盖 exe。"
    }

    $failedCopy = "$exe.failed-$(Get-Date -Format yyyyMMdd-HHmmss)"
    try {
        Copy-Item $exe $failedCopy -Force -ErrorAction Stop
        Warn "起不来的新版本留作排查:$(Split-Path $failedCopy -Leaf)"
    } catch { }

    try {
        Copy-Item $backup $exe -Force -ErrorAction Stop
        Ok "已还原旧 exe:$(Split-Path $backup -Leaf)"
    } catch {
        Bad "还原旧 exe 失败:$($_.Exception.Message)。备份在:$backup,请手工复制回 mt5gateway.exe。"
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $service -Start
    $health = Wait-Health $listen 10 3

    if ($health) {
        $rolledBack = $true
        Bad "已回滚到旧版本并恢复运行。本次更新没有生效——看下面的日志找新版本起不来的原因。"
    } else {
        $rollbackFailed = $true
        Bad "回滚后旧版本也没有通过健康检查!网关当前可能不可用,请立即人工处理。"
        Bad "多半不是程序版本的问题(券商连不上、gateway.ini、端口被占等),看下面的日志。"
    }
} else {
    Bad "启动后健康检查没通过,下面看一下状态和日志找原因。"
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $service -Status

# ---- 5. 健康检查 + 实时日志 ----
Step "5/5 当前状态"
if ($rolledBack) {
    Bad "注意:当前运行的是回滚后的【旧版本】,新版本未生效。"
}
if ($rollbackFailed) {
    Bad "注意:回滚后仍无响应,网关可能处于停机状态!"
}
try {
    $h = Invoke-RestMethod -Uri "http://$listen/health" -TimeoutSec 5
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
