#Requires -Version 3
# Build the sink subscription probe (SinkProbe.exe).
# One-off verification tool. Does not affect the running mt5gateway.exe.
# Usage (from the gateway directory):
#     .\build-probe.ps1
#     .\SinkProbe.exe 120

$ErrorActionPreference = "Stop"

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    Write-Error "csc.exe not found. .NET Framework 4.x is required."
}

$libs = Join-Path $PSScriptRoot "..\MetaTrader5SDK\Libs"
if (-not (Test-Path $libs)) {
    Write-Error "SDK Libs directory not found: $libs"
}

Push-Location $PSScriptRoot
try {
    & $csc /nologo /target:exe /platform:x64 /out:SinkProbe.exe `
        /reference:"$libs\MetaQuotes.MT5CommonAPI64.dll" `
        /reference:"$libs\MetaQuotes.MT5ManagerAPI64.dll" `
        SinkProbe.cs

    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed" }

    Write-Host ""
    Write-Host "[OK] Built: SinkProbe.exe" -ForegroundColor Green
    Write-Host ""
    Write-Host "Run it (reads gateway.ini in the same folder, no password prompt):"
    Write-Host "  .\SinkProbe.exe 120"
    Write-Host ""
    Write-Host "Then open a position and close it within those 120 seconds."
    Write-Host "The probe is read-only: it never places or modifies orders."
    Write-Host ""
}
finally {
    Pop-Location
}
