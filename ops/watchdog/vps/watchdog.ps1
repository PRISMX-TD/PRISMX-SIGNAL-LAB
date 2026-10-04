#Requires -Version 3
<#
    PRISMX gateway 看门狗(跑在 Windows VPS 上,由计划任务 PRISMX-Watchdog 以 SYSTEM 常驻)。

    gateway 自己已经会处理两种卡死(全局锁 3 分钟拿不到、连续 15 分钟不能交易 → 自己退出),
    计划任务 PRISMX-Gateway 也会在进程消失后 1~2 分钟内拉起。这个脚本只补它们看不到的:

      会自动动手的:
        · 进程活着但 /health 连续 FailLimit 轮不响应 → 杀掉进程、重新启动计划任务
        · 计划任务是启用的、进程却消失超过 ProcessMissingSec 秒 → 启动计划任务
        以上两项 1 小时最多 MaxRestartsPerHour 次,用完就停手并报警。
        有人在维护时(restart-gateway.ps1 / install-service.ps1 / build.ps1 / csc 在跑,
        或者计划任务被禁用)一律不动手。

      只通知、不动手的:
        · gateway 自己重启过(自愈退出或崩溃),附上日志里的自愈原因
        · 计划任务被禁用超过 TaskDisabledAlertSec 秒(9 月就这样静默停了 18 天)
        · MT5 断开超过 Mt5DownAlertSec 秒;连着 MT5 但下单通道(dealer)不可用超过 DealerDownAlertSec 秒

    通知渠道:邮件(Resend)和 Telegram,默认都关着,在 watchdog.ini 里打开。

    运维接口(管理后台的「重启 gateway」按钮):只听 WireGuard 隧道地址(OpsListen),只接受
    SG 看门狗用共享密钥 OpsSharedSecret 签过名的请求(60 秒内、随机数没见过)。按钮本身的
    鉴权(登录 token + 运维口令)在 SG 那边做,这里只认签名。手动重启与自动重启共用每小时
    MaxRestartsPerHour 次的额度,另有 OpsCooldownSec 秒冷却。没配 OpsSharedSecret 就不开。

    用法:
        .\watchdog.ps1              常驻(计划任务就是这样跑的)
        .\watchdog.ps1 -Once        查一轮,只打印,不重启、不发通知
        .\watchdog.ps1 -TestAlert   通过已启用的渠道发一条测试通知

    安装/卸载/看状态用同目录的 install-watchdog.ps1。
#>
param(
    [switch]$Once,
    [switch]$TestAlert,
    [switch]$SelfTestSignature,
    [string]$Config = ""
)

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
if (-not $Config) { $Config = Join-Path $here "watchdog.ini" }

# PowerShell 5.1 默认可能不带 TLS 1.2,Resend / Telegram 都要求它
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------- 配置

$Cfg = [ordered]@{
    MachineLabel         = "VPS gateway"
    GatewayDir           = "C:\Users\Administrator\Desktop\gateway"
    TaskName             = "PRISMX-Gateway"
    ProcessName          = "mt5gateway"
    HealthUrl            = ""
    CheckEverySec        = 30
    HealthTimeoutSec     = 5
    FailLimit            = 3
    StartupGraceSec      = 120
    MaxRestartsPerHour   = 3
    ProcessMissingSec    = 240
    TaskDisabledAlertSec = 600
    Mt5DownAlertSec      = 300
    DealerDownAlertSec   = 300
    MaintenanceQuietSec  = 600
    RepeatAlertSec       = 1800
    EmailEnabled         = "false"
    ResendApiKey         = ""
    MailFrom             = "noreply@prismxsignallab.com"
    EmailTo              = ""
    TelegramEnabled      = "false"
    TelegramBotToken     = ""
    TelegramChatIds      = ""
    OpsListen            = "http://10.66.0.2:8791/"
    OpsSharedSecret      = ""
    OpsAllowedIps        = "10.66.0.1"
    OpsCooldownSec       = 300
}

if (Test-Path $Config) {
    foreach ($line in [IO.File]::ReadAllLines($Config, [Text.Encoding]::UTF8)) {
        $t = $line.Trim()
        if ($t.Length -eq 0 -or $t.StartsWith("#") -or $t.StartsWith(";") -or $t.StartsWith("[")) { continue }
        $i = $t.IndexOf("=")
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        $v = $t.Substring($i + 1).Trim()
        if ($v.Length -ge 2 -and ($v[0] -eq '"' -or $v[0] -eq "'") -and $v[-1] -eq $v[0]) { $v = $v.Substring(1, $v.Length - 2) }
        $Cfg[$k] = $v
    }
}

foreach ($k in @("CheckEverySec", "HealthTimeoutSec", "FailLimit", "StartupGraceSec", "MaxRestartsPerHour",
                 "ProcessMissingSec", "TaskDisabledAlertSec", "Mt5DownAlertSec", "DealerDownAlertSec",
                 "MaintenanceQuietSec", "RepeatAlertSec", "OpsCooldownSec")) {
    $Cfg[$k] = [int]$Cfg[$k]
}

function As-Bool($v) { return @("1", "true", "yes", "on") -contains ([string]$v).Trim().ToLowerInvariant() }
# 前面的逗号让单个元素也保持数组(否则 PowerShell 会把它拆成字符串)
function As-List($v) { return ,@(([string]$v) -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

# 与 install-service.ps1 的 Get-ListenAddress 同一套规则:读 gateway.ini 的 listen,
# `+` / `*` / `0.0.0.0` 用 127.0.0.1;写了具体 IP(WireGuard 的 10.66.0.2)就打那个 IP。
function Get-HealthUrl {
    if ($Cfg.HealthUrl) { return $Cfg.HealthUrl }
    $listenHost = "127.0.0.1"; $port = 8800
    $ini = Join-Path $Cfg.GatewayDir "gateway.ini"
    if (Test-Path $ini) {
        foreach ($line in [IO.File]::ReadAllLines($ini)) {
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
    return "http://$($listenHost):$port/health"
}

# ---------------------------------------------------------------- 日志

$LogDir = Join-Path $here "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

function Get-BeijingTime { return [DateTime]::UtcNow.AddHours(8) }

function Write-WdLog($msg) {
    $ts = (Get-BeijingTime).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "$ts  $msg"
    Write-Host $line
    try {
        $file = Join-Path $LogDir ("watchdog-{0:yyyyMMdd}.log" -f (Get-BeijingTime))
        [IO.File]::AppendAllText($file, $line + "`r`n", [Text.Encoding]::UTF8)
    } catch { }
}

function Remove-OldLogs {
    try {
        Get-ChildItem $LogDir -Filter "watchdog-*.log" |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }
}

# ---------------------------------------------------------------- 通知

$script:LastSent = @{}
$script:DryRun = [bool]$Once

function Get-Channels {
    $ch = @()
    if (As-Bool $Cfg.EmailEnabled) { $ch += "email" }
    if (As-Bool $Cfg.TelegramEnabled) { $ch += "telegram" }
    return ,$ch
}

function Send-PostJson($url, $obj, $headers) {
    $json = $obj | ConvertTo-Json -Compress -Depth 4
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $req = [Net.HttpWebRequest]::Create($url)
    $req.Method = "POST"
    $req.ContentType = "application/json; charset=utf-8"
    $req.Timeout = 15000
    $req.ReadWriteTimeout = 15000
    $req.UserAgent = "prismx-watchdog"
    if ($headers) { foreach ($k in $headers.Keys) { $req.Headers[$k] = $headers[$k] } }
    $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream()
    try { $s.Write($bytes, 0, $bytes.Length) } finally { $s.Close() }
    $resp = $req.GetResponse()
    $resp.Close()
}

# $key 相同的通知在 RepeatAlertSec 内只发一次。返回实际发出去的渠道。
function Send-Alert($title, $body, $key = $null) {
    $now = $script:Clock.Elapsed.TotalSeconds
    if ($key) {
        if ($script:LastSent.ContainsKey($key) -and ($now - $script:LastSent[$key]) -lt $Cfg.RepeatAlertSec) { return @() }
        $script:LastSent[$key] = $now
    }
    $subject = "[PRISMX 看门狗] $($Cfg.MachineLabel) · $title"
    $text = "$subject`n`n$body`n`n时间:$((Get-BeijingTime).ToString('yyyy-MM-dd HH:mm:ss'))(北京时间)`n机器:$($Cfg.MachineLabel)"
    Write-WdLog ("通知:$title | " + ($body -replace "`r?`n", " / "))
    if ($script:DryRun) { return @() }

    $sent = @()
    foreach ($ch in (Get-Channels)) {
        try {
            if ($ch -eq "email") {
                $to = As-List $Cfg.EmailTo
                if ($to.Count -eq 0 -or -not $Cfg.ResendApiKey) { throw "EmailTo 或 ResendApiKey 没配" }
                Send-PostJson "https://api.resend.com/emails" `
                    @{ from = "PRISMX 看门狗 <$($Cfg.MailFrom)>"; to = $to; subject = $subject; text = $text } `
                    @{ Authorization = "Bearer $($Cfg.ResendApiKey)" }
            } else {
                $chats = As-List $Cfg.TelegramChatIds
                if ($chats.Count -eq 0 -or -not $Cfg.TelegramBotToken) { throw "TelegramBotToken 或 TelegramChatIds 没配" }
                $failed = @()
                foreach ($c in $chats) {
                    # 异常信息里不带 URL,token 不会进日志
                    try { Send-PostJson "https://api.telegram.org/bot$($Cfg.TelegramBotToken)/sendMessage" @{ chat_id = $c; text = $text } $null }
                    catch { $failed += $c }
                }
                if ($failed.Count -gt 0) { throw ("部分 chat 发送失败:" + ($failed -join ", ")) }
            }
            $sent += $ch
        } catch {
            Write-WdLog "通知发送失败($ch):$($_.Exception.Message)"
        }
    }
    return $sent
}

# ---------------------------------------------------------------- 探测

function Invoke-Health($url, $timeoutSec) {
    try {
        $req = [Net.HttpWebRequest]::Create($url)
        $req.Timeout = $timeoutSec * 1000
        $req.ReadWriteTimeout = $timeoutSec * 1000
        $req.Proxy = $null
        $resp = $req.GetResponse()
        try {
            $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
            $body = $sr.ReadToEnd()
        } finally { $resp.Close() }
        $data = $null
        try { $data = $body | ConvertFrom-Json } catch { }
        return @{ Ok = $true; Data = $data; Error = "" }
    } catch {
        $e = $_.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        return @{ Ok = $false; Data = $null; Error = $e.Message }
    }
}

function Get-GatewayProcess {
    return Get-Process -Name $Cfg.ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-TaskState {
    $t = Get-ScheduledTask -TaskName $Cfg.TaskName -ErrorAction SilentlyContinue
    if ($t) { return [string]$t.State }
    return "Missing"
}

# 有人在维护 gateway 时看门狗让路。只看启动不到 15 分钟的进程:restart-gateway.ps1
# 做完以后会在同一个窗口里一直滚日志(Get-Content -Wait),窗口开一整天它就一直"在跑",
# 不加时限的话看门狗会被一个忘了关的日志窗口永久架空。
# Only processes younger than 15 min count: restart-gateway.ps1 keeps tailing the
# log in the same process, so an open window would otherwise disarm the watchdog.
function Test-Maintenance {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='csc.exe'" -ErrorAction Stop
        foreach ($p in $procs) {
            if ($p.CreationDate -and ((Get-Date) - $p.CreationDate).TotalMinutes -gt 15) { continue }
            if ($p.Name -eq "csc.exe") { return $true }
            if ([string]$p.CommandLine -match 'restart-gateway\.ps1|install-service\.ps1|build\.ps1') { return $true }
        }
    } catch { }
    return $false
}

# gateway 日志里最近一条"自愈"记录(今天和昨天的日志)。
function Get-SelfHealReason {
    $dir = Join-Path $Cfg.GatewayDir "logs"
    foreach ($d in @((Get-Date), (Get-Date).AddDays(-1))) {
        $f = Join-Path $dir ("gateway-{0:yyyyMMdd}.log" -f $d)
        if (-not (Test-Path $f)) { continue }
        try {
            $hit = Get-Content $f -Tail 3000 -Encoding UTF8 -ErrorAction Stop | Where-Object { $_ -match '自愈' } | Select-Object -Last 1
            if ($hit) { return $hit.Trim() }
        } catch { }
    }
    return ""
}

function Restart-GatewayTask {
    Stop-ScheduledTask -TaskName $Cfg.TaskName -ErrorAction SilentlyContinue
    Get-Process -Name $Cfg.ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Start-ScheduledTask -TaskName $Cfg.TaskName -ErrorAction Stop
}

# ---------------------------------------------------------------- 小工具:持续坏了多久 / 重启名额

function New-Tracker($threshold) { return @{ Threshold = $threshold; BadSince = $null; Alerted = $false } }

# 持续坏够阈值返回 "down"(只一次),恢复时返回 "recovered"(只在报过 down 之后)。
function Update-Tracker($t, $ok, $now) {
    if ($ok) {
        $was = $t.Alerted
        $t.BadSince = $null; $t.Alerted = $false
        if ($was) { return "recovered" }
        return $null
    }
    if ($null -eq $t.BadSince) { $t.BadSince = $now }
    if (-not $t.Alerted -and ($now - $t.BadSince) -ge $t.Threshold) { $t.Alerted = $true; return "down" }
    return $null
}

function Get-DownFor($t, $now) { if ($null -eq $t.BadSince) { return 0 } return [int]($now - $t.BadSince) }

$script:RestartStamps = New-Object System.Collections.ArrayList
function Get-RestartsUsed($now) {
    $keep = @($script:RestartStamps | Where-Object { ($now - $_) -lt 3600 })
    $script:RestartStamps.Clear()
    foreach ($s in $keep) { [void]$script:RestartStamps.Add($s) }
    return $script:RestartStamps.Count
}

# ---------------------------------------------------------------- 状态

$script:Clock = [Diagnostics.Stopwatch]::StartNew()
$script:FailStreak = 0
$script:LastStartTime = $null
$script:ExpectNewProcess = $false
$script:LastMaintenanceAt = -100000
$script:TrkDisabled = New-Tracker $Cfg.TaskDisabledAlertSec
$script:TrkMissing = New-Tracker $Cfg.ProcessMissingSec
$script:TrkMt5 = New-Tracker $Cfg.Mt5DownAlertSec
$script:TrkDealer = New-Tracker $Cfg.DealerDownAlertSec
$HealthUrl = Get-HealthUrl

# 动手前统一过一遍名额。返回 $true = 可以动手。
function Request-Restart($why, $now) {
    if ((Get-RestartsUsed $now) -ge $Cfg.MaxRestartsPerHour) {
        Send-Alert "gateway 仍然异常,看门狗已停手" ("$why`n但 1 小时内已经自动处理了 $($Cfg.MaxRestartsPerHour) 次,再重启也没用,需要人工处理。`n" +
            "看 gateway 日志:$($Cfg.GatewayDir)\logs\gateway-$((Get-Date).ToString('yyyyMMdd')).log") "exhausted" | Out-Null
        return $false
    }
    if ($script:DryRun) { Write-WdLog "[dry-run] 本该处理:$why"; return $false }
    [void]$script:RestartStamps.Add($now)
    return $true
}

function Invoke-Tick {
    $now = $script:Clock.Elapsed.TotalSeconds
    $taskState = Get-TaskState
    $maint = Test-Maintenance
    if ($maint -or $taskState -eq "Disabled") { $script:LastMaintenanceAt = $now }
    $recentMaint = ($now - $script:LastMaintenanceAt) -lt $Cfg.MaintenanceQuietSec
    $proc = Get-GatewayProcess
    $uptime = $null
    if ($proc) { try { $uptime = ((Get-Date) - $proc.StartTime).TotalSeconds } catch { } }
    $h = Invoke-Health $HealthUrl $Cfg.HealthTimeoutSec

    $r = [ordered]@{ taskState = $taskState; maintenance = $maint; processId = $(if ($proc) { $proc.Id } else { $null });
                     uptimeSec = $(if ($null -ne $uptime) { [int]$uptime } else { $null }); healthUrl = $HealthUrl;
                     healthOk = $h.Ok; healthError = $h.Error; failStreak = 0; action = "" }

    # 1) 计划任务被禁用太久
    switch (Update-Tracker $script:TrkDisabled ($taskState -ne "Disabled") $now) {
        "down" { Send-Alert "gateway 计划任务被禁用了" ("计划任务 $($Cfg.TaskName) 已禁用 $(Get-DownFor $script:TrkDisabled $now) 秒。禁用期间开机自启和崩溃自动拉起都不生效,看门狗也不会动它。`n" +
                    "多半是上次 install-service.ps1 -Stop 之后忘了 -Start。在 gateway 目录用管理员 PowerShell 执行:.\install-service.ps1 -Start") | Out-Null }
        "recovered" { Send-Alert "gateway 计划任务已重新启用" "计划任务恢复为启用状态。" | Out-Null }
    }
    if ($taskState -eq "Missing") {
        Send-Alert "找不到 gateway 计划任务" "计划任务 $($Cfg.TaskName) 不存在,看门狗无法管理 gateway。需要重新执行 install-service.ps1。" "task-missing" | Out-Null
    }

    $canAct = (-not $maint) -and ($taskState -ne "Disabled") -and ($taskState -ne "Missing")

    # 2) gateway 自己重启过(进程启动时间变了,而不是看门狗或维护造成的)
    if ($proc) {
        $st = $null; try { $st = $proc.StartTime } catch { }
        if ($null -ne $st -and $null -ne $script:LastStartTime -and $st -ne $script:LastStartTime) {
            if ($script:ExpectNewProcess) {
                $script:ExpectNewProcess = $false
            } elseif (-not $recentMaint) {
                $reason = Get-SelfHealReason
                if ($reason) { $msg = "gateway 进程重启过,日志里最近的自愈记录:`n$reason" }
                else { $msg = "gateway 进程重启过,日志里没有自愈记录,可能是崩溃后被计划任务拉起。" }
                Send-Alert "gateway 自己重启过" "$msg`n目前已重新运行。频繁出现说明有根本问题要查。" | Out-Null
            }
        }
        if ($null -ne $st) { $script:LastStartTime = $st }
    }

    # 3) 进程消失太久,计划任务没把它拉起来
    $ev = Update-Tracker $script:TrkMissing ([bool]$proc -or -not $canAct) $now
    if ($ev -eq "down") {
        $why = "gateway 进程已消失 $(Get-DownFor $script:TrkMissing $now) 秒,计划任务没有自动拉起。"
        if (Request-Restart $why $now) {
            try {
                Start-ScheduledTask -TaskName $Cfg.TaskName -ErrorAction Stop
                $script:ExpectNewProcess = $true
                $r.action = "started"
                Send-Alert "gateway 没在运行,已自动启动" "$why`n看门狗已启动计划任务。1 小时内已自动处理 $(Get-RestartsUsed $now) 次(上限 $($Cfg.MaxRestartsPerHour) 次)。" | Out-Null
            } catch {
                Send-Alert "gateway 没在运行,自动启动失败" "$why`n启动计划任务失败:$($_.Exception.Message)" | Out-Null
            }
        }
        # 让它下一轮还能再判一次
        $script:TrkMissing.Alerted = $false; $script:TrkMissing.BadSince = $now
    } elseif ($ev -eq "recovered") {
        # 已在上面的通知里说过,这里不再重复
    }

    # 4) 进程活着但 /health 不响应
    if ($proc -and $canAct -and $null -ne $uptime -and $uptime -ge $Cfg.StartupGraceSec) {
        if ($h.Ok) { $script:FailStreak = 0 }
        else {
            $script:FailStreak++
            Write-WdLog "gateway /health 第 $($script:FailStreak) 轮不响应:$($h.Error)"
            if ($script:FailStreak -ge $Cfg.FailLimit) {
                $why = "gateway 进程在运行,但 /health 连续 $($script:FailStreak) 轮没响应($($h.Error))。"
                if (Request-Restart $why $now) {
                    try {
                        Restart-GatewayTask
                        $script:ExpectNewProcess = $true
                        $r.action = "restarted"
                        Send-Alert "gateway 卡死,已自动重启" "$why`n看门狗已杀掉旧进程并重新启动。在途订单由 gateway 的幂等记录兜底,不会重复执行。`n1 小时内已自动处理 $(Get-RestartsUsed $now) 次(上限 $($Cfg.MaxRestartsPerHour) 次)。" | Out-Null
                    } catch {
                        Send-Alert "gateway 卡死,自动重启失败" "$why`n重启失败:$($_.Exception.Message)" | Out-Null
                    }
                    $script:FailStreak = 0
                }
            }
        }
    } else {
        $script:FailStreak = 0
    }
    $r.failStreak = $script:FailStreak

    # 5) MT5 连接与下单通道(只在 /health 有回应时判断)
    if ($h.Ok -and $h.Data) {
        $connected = [bool]$h.Data.mt5Connected
        switch (Update-Tracker $script:TrkMt5 $connected $now) {
            "down" { Send-Alert "gateway 连不上 MT5" "gateway 已 $(Get-DownFor $script:TrkMt5 $now) 秒连不上券商 MT5 服务器,用户无法下单、查持仓。gateway 会自己重连,连续 15 分钟连不上会自己重启;券商那边出问题时重启也没用。" | Out-Null }
            "recovered" { Send-Alert "gateway 已重新连上 MT5" "MT5 连接恢复。" | Out-Null }
        }
        $dealerOk = (-not $connected) -or [bool]$h.Data.dealerActive
        switch (Update-Tracker $script:TrkDealer $dealerOk $now) {
            "down" { Send-Alert "gateway 能查不能下单" "MT5 连着,但下单通道(dealer)已 $(Get-DownFor $script:TrkDealer $now) 秒不可用:查持仓、查余额正常,下单会失败。gateway 每 10 秒会自己重试。" | Out-Null }
            "recovered" { Send-Alert "gateway 下单通道已恢复" "dealer 恢复可用。" | Out-Null }
        }
        $r.mt5Connected = $connected
        $r.dealerActive = [bool]$h.Data.dealerActive
    }

    return $r
}

# ---------------------------------------------------------------- 运维接口(SG 看门狗转来的按钮)

$script:OpsNonces = @{}
$script:OpsLastRestartAt = -100000
$script:OpsHistory = New-Object System.Collections.ArrayList
$OpsHistoryFile = Join-Path $LogDir "ops-history.jsonl"
if (Test-Path $OpsHistoryFile) {
    try {
        foreach ($line in (Get-Content $OpsHistoryFile -Tail 50 -Encoding UTF8)) {
            try { [void]$script:OpsHistory.Add(($line | ConvertFrom-Json)) } catch { }
        }
    } catch { }
}

function Add-OpsHistory($action, $operator, $result, $source = "manual") {
    $item = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); action = $action; operator = $operator; result = $result; source = $source }
    [void]$script:OpsHistory.Add([pscustomobject]$item)
    while ($script:OpsHistory.Count -gt 50) { $script:OpsHistory.RemoveAt(0) }
    try { [IO.File]::AppendAllText($OpsHistoryFile, (($item | ConvertTo-Json -Compress) + "`n"), (New-Object Text.UTF8Encoding($false))) } catch { }
}

# 与 SG 端 prismx_ops.sign_request 完全相同的签名:方法、路径、时间戳、随机数、请求体,
# 以换行连接后做 HMAC-SHA256(十六进制小写)。
function Get-OpsSignature($secret, $method, $path, $ts, $nonce, $body) {
    $h = New-Object Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes($secret))
    try {
        $msg = [Text.Encoding]::UTF8.GetBytes(($method.ToUpperInvariant(), $path, $ts, $nonce, $body) -join "`n")
        return (($h.ComputeHash($msg) | ForEach-Object { $_.ToString("x2") }) -join "")
    } finally { $h.Dispose() }
}

# 定长比较,不在第一个不同字符处提前返回。
function Test-SameString($a, $b) {
    if ($null -eq $a -or $null -eq $b -or $a.Length -ne $b.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $a.Length; $i++) { $diff = $diff -bor ([int][char]$a[$i] -bxor [int][char]$b[$i]) }
    return $diff -eq 0
}

function Test-OpsRequest($req, $path, $body) {
    $ts = $req.Headers["X-Ops-Ts"]; $nonce = $req.Headers["X-Ops-Nonce"]; $sig = $req.Headers["X-Ops-Sig"]
    if (-not $ts -or -not $nonce -or -not $sig) { return "缺少签名" }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $tsNum = 0L
    if (-not [long]::TryParse($ts, [ref]$tsNum) -or [Math]::Abs($now - $tsNum) -gt 60) { return "签名时间不对(时钟偏差超过 60 秒)" }
    foreach ($k in @($script:OpsNonces.Keys)) { if ($now - $script:OpsNonces[$k] -gt 300) { $script:OpsNonces.Remove($k) } }
    if ($script:OpsNonces.ContainsKey($nonce)) { return "重放的请求" }
    $expected = Get-OpsSignature $Cfg.OpsSharedSecret $req.HttpMethod $path $ts $nonce $body
    if (-not (Test-SameString $expected ([string]$sig).ToLowerInvariant())) { return "签名不对" }
    $script:OpsNonces[$nonce] = $now
    return $null
}

function Send-OpsJson($ctx, $status, $obj) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 5))
    $resp = $ctx.Response
    $resp.StatusCode = $status
    $resp.ContentType = "application/json; charset=utf-8"
    $resp.ContentLength64 = $bytes.Length
    try { $resp.OutputStream.Write($bytes, 0, $bytes.Length) } finally { $resp.Close() }
}

function Invoke-OpsRequest($ctx) {
    $req = $ctx.Request
    $path = $req.Url.AbsolutePath.TrimEnd("/")
    $ip = [string]$req.RemoteEndPoint.Address
    $allowed = As-List $Cfg.OpsAllowedIps
    if ($allowed.Count -gt 0 -and -not ($allowed -contains $ip)) {
        Write-WdLog "运维接口拒绝来源 $ip"
        return Send-OpsJson $ctx 403 @{ ok = $false; error = "forbidden"; message = "来源地址不被允许" }
    }
    if ($req.ContentLength64 -gt 4096) { return Send-OpsJson $ctx 413 @{ ok = $false; error = "too_large" } }
    $body = ""
    if ($req.HasEntityBody) {
        $sr = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
        try { $body = $sr.ReadToEnd() } finally { $sr.Close() }
    }
    $bad = Test-OpsRequest $req $path $body
    if ($bad) {
        Write-WdLog "运维接口拒绝 $($req.HttpMethod) $path(来自 $ip):$bad"
        return Send-OpsJson $ctx 401 @{ ok = $false; error = "bad_signature"; message = $bad }
    }

    $now = $script:Clock.Elapsed.TotalSeconds
    $cooldown = [int][Math]::Max(0, $Cfg.OpsCooldownSec - ($now - $script:OpsLastRestartAt))
    if ($path -eq "/ops/status" -and $req.HttpMethod -eq "GET") {
        $recent = @($script:OpsHistory | Select-Object -Last 10)
        [array]::Reverse($recent)
        return Send-OpsJson $ctx 200 ([ordered]@{
            restartsUsed = (Get-RestartsUsed $now); restartsMax = $Cfg.MaxRestartsPerHour; cooldownSec = $cooldown
            taskState = (Get-TaskState); history = $recent
        })
    }
    if ($path -ne "/ops/restart-gateway" -or $req.HttpMethod -ne "POST") {
        return Send-OpsJson $ctx 404 @{ ok = $false; error = "not_found" }
    }

    $operator = "?"
    try { $operator = [string](($body | ConvertFrom-Json).operator) } catch { }
    if ($cooldown -gt 0) {
        Add-OpsHistory "restart-gateway" $operator "refused: cooldown"
        return Send-OpsJson $ctx 429 @{ ok = $false; error = "cooldown"; message = "5 分钟内已经重启过 gateway,$cooldown 秒后才能再按"; retryAfter = $cooldown }
    }
    if ((Get-RestartsUsed $now) -ge $Cfg.MaxRestartsPerHour) {
        Add-OpsHistory "restart-gateway" $operator "refused: budget"
        return Send-OpsJson $ctx 429 @{ ok = $false; error = "budget"; message = "gateway 1 小时内已经重启过 $($Cfg.MaxRestartsPerHour) 次,不要再重启了,联系 Rex" }
    }
    $state = Get-TaskState
    if ($state -eq "Disabled" -or $state -eq "Missing" -or (Test-Maintenance)) {
        Add-OpsHistory "restart-gateway" $operator "refused: maintenance"
        return Send-OpsJson $ctx 409 @{ ok = $false; error = "maintenance"; message = "gateway 正在维护(计划任务被禁用或正在编译重启),先不要按,联系 Rex" }
    }

    [void]$script:RestartStamps.Add($now)
    $script:OpsLastRestartAt = $now
    Write-WdLog "管理员 $operator 通过管理后台重启 gateway"
    try {
        Restart-GatewayTask
        $script:ExpectNewProcess = $true
        $script:FailStreak = 0
        Add-OpsHistory "restart-gateway" $operator "ok"
        Send-Alert "管理员 $operator 手动重启了 gateway" ("通过管理后台的「重启 gateway」按钮。直连账户 10~30 秒内下不了单。`n" +
            "1 小时内已重启 $(Get-RestartsUsed $now) 次(含自动,上限 $($Cfg.MaxRestartsPerHour) 次)。") | Out-Null
        return Send-OpsJson $ctx 202 @{ ok = $true; result = "ok"; message = "已开始重启 gateway,10~30 秒后恢复" }
    } catch {
        $msg = $_.Exception.Message
        Add-OpsHistory "restart-gateway" $operator "failed: $msg"
        Send-Alert "管理员 $operator 手动重启 gateway 失败" "失败原因:$msg" | Out-Null
        return Send-OpsJson $ctx 500 @{ ok = $false; error = "restart_failed"; message = "重启 gateway 失败:$msg" }
    }
}

function Start-OpsListener {
    if (-not $Cfg.OpsListen -or -not $Cfg.OpsSharedSecret) { return $null }
    try {
        $l = New-Object Net.HttpListener
        $l.Prefixes.Add($Cfg.OpsListen)
        $l.Start()
        Write-WdLog "运维接口已开:$($Cfg.OpsListen)"
        return $l
    } catch {
        # 开机时 WireGuard 可能还没起来、隧道地址还不存在;主循环过一分钟再试。
        Write-WdLog "运维接口暂时开不了(1 分钟后重试):$($_.Exception.Message)"
        return $null
    }
}

# ---------------------------------------------------------------- 入口

if ($SelfTestSignature) {
    # 固定向量,必须与 SG 端 prismx_ops.sign_request("shh", "post", "/ops/restart-gateway",
    # '{"operator":"alice"}', ts=1700000000, nonce="abc") 一致(见 sg/test_prismx_ops.py)。
    Get-OpsSignature "shh" "post" "/ops/restart-gateway" "1700000000" "abc" '{"operator":"alice"}'
    exit 0
}

if ($TestAlert) {
    $script:DryRun = $false
    if ((Get-Channels).Count -eq 0) {
        Write-WdLog "邮件和 Telegram 都没启用(EmailEnabled / TelegramEnabled),没有发送。"
        exit 1
    }
    $sent = Send-Alert "测试通知" "这是一条测试通知,收到说明看门狗的通知渠道配置正确。"
    Write-WdLog ("已发送渠道:" + $(if ($sent.Count) { $sent -join ", " } else { "无" }))
    if ($sent.Count) { exit 0 } else { exit 1 }
}

if ($Once) {
    $r = Invoke-Tick
    $r | ConvertTo-Json | Write-Host
    exit 0
}

# 同一时间只跑一份(计划任务每 5 分钟触发一次兜底,已有实例时这里直接退出)
$mutex = New-Object Threading.Mutex($false, "Global\PRISMX-Watchdog")
if (-not $mutex.WaitOne(0)) { exit 0 }

$channels = Get-Channels
Write-WdLog ("看门狗启动:健康检查 $HealthUrl,每 $($Cfg.CheckEverySec) 秒一次,通知渠道:" + $(if ($channels.Count) { $channels -join ", " } else { "未启用" }))
if (-not $Cfg.OpsSharedSecret) { Write-WdLog "运维接口没开:watchdog.ini 里没有 OpsSharedSecret(管理后台的「重启 gateway」按钮不可用)" }

# 主循环:每半秒看一眼有没有运维请求,每 CheckEverySec 秒做一轮健康检查。
# Main loop: poll for ops requests every 0.5s, run a health tick every CheckEverySec.
$lastCleanup = -100000
$nextTick = 0
$listener = $null
$listenerRetryAt = 0
$pending = $null
while ($true) {
    $now = $script:Clock.Elapsed.TotalSeconds
    if ($now -ge $nextTick) {
        try { Invoke-Tick | Out-Null }
        catch { Write-WdLog "本轮检查出错(继续):$($_.Exception.Message)" }
        if ($now - $lastCleanup -gt 86400) { Remove-OldLogs; $lastCleanup = $now }
        $nextTick = $now + $Cfg.CheckEverySec
    }
    if ($null -eq $listener -and $Cfg.OpsSharedSecret -and $now -ge $listenerRetryAt) {
        $listener = Start-OpsListener
        $listenerRetryAt = $now + 60
    }
    if ($null -ne $listener) {
        try {
            if ($null -eq $pending) { $pending = $listener.GetContextAsync() }
            if ($pending.Wait(500)) {
                $ctx = $pending.Result
                $pending = $null
                try { Invoke-OpsRequest $ctx }
                catch {
                    Write-WdLog "运维接口出错:$($_.Exception.Message)"
                    try { Send-OpsJson $ctx 500 @{ ok = $false; error = "internal" } } catch { }
                }
            }
        } catch {
            Write-WdLog "运维接口异常,重新打开:$($_.Exception.Message)"
            try { $listener.Close() } catch { }
            $listener = $null; $pending = $null
        }
    } else {
        Start-Sleep -Milliseconds 500
    }
}
