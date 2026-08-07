#Requires -Version 3
# Build the open-with-SL/TP probe (SlTpProbe.exe).
#
# One-off verification tool. Does not affect the running mt5gateway.exe.
#
# WARNING: unlike SinkProbe, this probe PLACES A REAL ORDER (0.01 lots) and
# then closes it. Run it on a demo account only.
#
# Usage (from the gateway directory):
#     .\build-sltp-probe.ps1
#     .\SlTpProbe.exe <demoClientLogin> EURUSD --i-understand-this-places-a-real-order

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
    & $csc /nologo /target:exe /platform:x64 /out:SlTpProbe.exe `
        /reference:"$libs\MetaQuotes.MT5CommonAPI64.dll" `
        /reference:"$libs\MetaQuotes.MT5ManagerAPI64.dll" `
        SlTpProbe.cs

    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed" }

    Write-Host ""
    Write-Host "[OK] Built: SlTpProbe.exe" -ForegroundColor Green
    Write-Host ""
    Write-Host "This probe places a REAL 0.01-lot market order, then closes it." -ForegroundColor Yellow
    Write-Host "Use a demo account only." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Run it (reads gateway.ini in the same folder):"
    Write-Host "  .\SlTpProbe.exe <demoClientLogin> EURUSD --i-understand-this-places-a-real-order"
    Write-Host ""
}
finally {
    Pop-Location
}
