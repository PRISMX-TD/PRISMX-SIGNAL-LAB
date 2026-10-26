#Requires -Version 3
<#
    编译 PRISMX MT5 Gateway。
    不需要 Visual Studio,用 .NET Framework 自带的 csc.exe。

    用法:在本目录执行  .\build.ps1
          .\build.ps1 -Out mt5gateway.new.exe   编译到另一个文件(网关照常运行,不占用正在跑的 exe)

    -Out:输出文件,相对路径按本目录算,默认 mt5gateway.exe。restart-gateway.ps1 用它在停服务
    之前先编译到临时 exe,编译失败就根本不停服务。指定 -Out 时不往本目录拷运行时 DLL
    (正在跑的网关占着它们,拷不进去),只核对它们与 SDK 目录里的是否一致,不一致就报错退出。
    -Out: output file (relative to this folder, default mt5gateway.exe). restart-gateway.ps1
    uses it to compile to a temp exe before stopping the service. With -Out the runtime DLLs
    are not copied (the running gateway holds them); they are only compared with the SDK's.
#>
param(
    [string]$Out = ""
)

$ErrorActionPreference = "Stop"

$defaultOut = Join-Path $PSScriptRoot "mt5gateway.exe"
$customOut = $false
if ($Out) {
    if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $PSScriptRoot $Out }
    $Out = [System.IO.Path]::GetFullPath($Out)
    if ($Out -ne [System.IO.Path]::GetFullPath($defaultOut)) { $customOut = $true }
} else {
    $Out = $defaultOut
}
$outName = Split-Path $Out -Leaf

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    Write-Error "找不到 csc.exe。需要 .NET Framework 4.x(Windows Server 一般自带)。"
}

# SDK 的引用 DLL。优先用仓库里的 SDK 目录;找不到就退回本目录——
# 部署到 VPS 时通常只复制了 gateway 这一个文件夹,而运行时需要的 5 个 DLL
# 本来就在里面(上一次编译时拷进来的),没必要为了改一行代码把整个 SDK 也搬过去。
# Prefer the repo's SDK dir; fall back to this folder, which is what a VPS has:
# deployments copy only gateway/, and the runtime DLLs already live there.
$libs = Join-Path $PSScriptRoot "..\MetaTrader5SDK\Libs"
$copyRuntimeDlls = $true

if (-not (Test-Path $libs)) {
    $libs = $PSScriptRoot
    $copyRuntimeDlls = $false
    Write-Host "未找到 SDK Libs 目录,改用本目录的 DLL 编译。" -ForegroundColor Yellow
}

foreach ($ref in @("MetaQuotes.MT5CommonAPI64.dll", "MetaQuotes.MT5ManagerAPI64.dll")) {
    if (-not (Test-Path (Join-Path $libs $ref))) {
        Write-Error "缺少引用 DLL:$(Join-Path $libs $ref)"
    }
}

# 打印这 5 个 DLL 的来源、版本与 SHA256。
#
# 为什么值得占几行输出:上面那个"找不到 SDK 就用本目录"的退路意味着 VPS 上的 DLL
# 版本从此只由"上一次编译时拷进来的那份"决定,而仓库里既没有这几个 DLL 的校验和、
# 也没有版本号记录——真出现"换了台机器之后连不上券商"时,没有任何办法回答"两边跑
# 的是不是同一份 Manager API"。Start() 里有运行期版本比对兜底,但那是失败之后才说话。
# 这里不去猜哪个版本才对(仓库里判定不了),只把每次编译实际用了什么记进构建输出,
# 让下次比对有据可依。
#
# Record where each DLL came from, its version and its hash. The "fall back to this
# folder" path above means the VPS's Manager API version is decided by whatever was
# copied in last time, and the repo pins neither a version nor a checksum — so after a
# machine move there is no way to answer "are both sides running the same API?". This
# does not guess which version is correct (the repo cannot tell); it just makes every
# build state what it actually used.
Write-Host ""
Write-Host "引用 DLL 来源:$libs" -ForegroundColor Cyan
foreach ($dll in @(
    "MetaQuotes.MT5CommonAPI64.dll",
    "MetaQuotes.MT5ManagerAPI64.dll",
    "MT5APIManager64.dll",
    "MT5APIManager64avx.dll",
    "MT5APIManager64avx2.dll"
)) {
    $p = Join-Path $libs $dll
    if (-not (Test-Path $p)) {
        # 原生 DLL 缺失不阻断编译(编译只需要那两个托管包装器),但产出的 exe 连不上
        # 券商,所以必须显眼地说出来,而不是等运行时报一个看不懂的加载失败。
        # A missing native DLL does not break compilation, only the resulting exe.
        Write-Host ("  {0,-32} 缺失 / MISSING" -f $dll) -ForegroundColor Red
        continue
    }
    $item = Get-Item $p
    $ver = $item.VersionInfo.FileVersion
    if (-not $ver) { $ver = "-" }
    $sha = (Get-FileHash $p -Algorithm SHA256).Hash
    Write-Host ("  {0,-32} v{1,-14} {2,10} 字节  SHA256 {3}" -f $dll, $ver, $item.Length, $sha)
}
Write-Host ""

Push-Location $PSScriptRoot
try {
    $sources = @(
        "Program.cs",
        "Config.cs",
        "Mt5Link.cs",
        "HttpServer.cs",
        "Models.cs",
        "Json.cs",
        "Log.cs",
        "Idempotency.cs",
        "ReadChannel.cs"
    )

    & $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$Out" `
        /reference:"$libs\MetaQuotes.MT5CommonAPI64.dll" `
        /reference:"$libs\MetaQuotes.MT5ManagerAPI64.dll" `
        $sources

    if ($LASTEXITCODE -ne 0) { Write-Error "编译失败" }

    # 运行时需要托管包装器 + 原生 DLL 与 exe 同目录。
    # AVX/AVX2 变体由 API 依 CPU 自动挑选,一并放着。
    # $libs 已经退回本目录时不用拷——源和目标是同一个文件,拷了反而报错。
    # 指定了 -Out(网关可能正在跑、占着这些 DLL)时不拷,只核对:不一致就报错,
    # 免得新 exe 按新 SDK 编译、运行时却加载到本目录的旧 DLL。
    # With -Out (the gateway may be running and holding these DLLs) only compare;
    # a mismatch fails the build rather than pairing a new exe with old DLLs.
    if ($copyRuntimeDlls -and $customOut) {
        foreach ($dll in @(
            "MetaQuotes.MT5CommonAPI64.dll",
            "MetaQuotes.MT5ManagerAPI64.dll",
            "MT5APIManager64.dll",
            "MT5APIManager64avx.dll",
            "MT5APIManager64avx2.dll"
        )) {
            $src = Join-Path $libs $dll
            $dst = Join-Path $PSScriptRoot $dll
            if (-not (Test-Path $src)) { continue }
            if ((-not (Test-Path $dst)) -or
                ((Get-FileHash $src -Algorithm SHA256).Hash -ne (Get-FileHash $dst -Algorithm SHA256).Hash)) {
                Write-Error ("本目录的 $dll 与 SDK 目录里的不一致(或缺失),不能只编译到 -Out 再替换 exe。" +
                    "请先停网关,再不带 -Out 运行 .\build.ps1 完整编译(会顺带拷 DLL)。")
            }
        }
    } elseif ($copyRuntimeDlls) {
        foreach ($dll in @(
            "MetaQuotes.MT5CommonAPI64.dll",
            "MetaQuotes.MT5ManagerAPI64.dll",
            "MT5APIManager64.dll",
            "MT5APIManager64avx.dll",
            "MT5APIManager64avx2.dll"
        )) {
            Copy-Item (Join-Path $libs $dll) . -Force
        }
    }

    Write-Host ""
    Write-Host "[OK] 编译完成:$outName" -ForegroundColor Green

    if (-not (Test-Path "gateway.ini")) {
        Write-Host ""
        Write-Host "还没有 gateway.ini。先复制模板并填写:" -ForegroundColor Yellow
        Write-Host "  Copy-Item gateway.ini.example gateway.ini"
    }

    Write-Host ""
    Write-Host "自检(按顺序):"
    Write-Host "  .\mt5gateway.exe selftest"
    Write-Host "  .\mt5gateway.exe selftest <demo客户账号>"
    Write-Host "  .\mt5gateway.exe selftest <demo客户账号> EURUSD 0.01"
    Write-Host ""
    Write-Host "正式运行:"
    Write-Host "  .\mt5gateway.exe serve"
    Write-Host ""
}
finally {
    Pop-Location
}
