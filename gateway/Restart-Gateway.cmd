@echo off
rem Double-click to restart the PRISMX gateway and follow its log.
rem The PowerShell script asks for admin rights by itself.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-gateway.ps1" %*
