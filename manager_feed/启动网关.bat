@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

REM 切到项目根目录（本脚本的上一级），python -m manager_feed.main 才能找到包。
REM 配置文件仍读 manager_feed\config.ini，与本脚本同目录。
REM Change to the project root (this script's parent) so python -m manager_feed.main can
REM resolve the package. The config is still read from manager_feed\config.ini, next to
REM this script.
cd /d "%~dp0.."
set "CFGDIR=%~dp0"

title PRISMX 行情网关 / Market Feed Gateway

echo ============================================================
echo   PRISMX 行情网关 / Market Feed Gateway
echo ============================================================
echo.

REM ---------- 1. 找 Python / locate Python ----------
REM 优先用 py 启动器，其次 python 命令。两者都没有就给出下载指引后退出，
REM 不自动下载安装包：静默装 Python 需要管理员权限，失败时的现场很难排查。
REM Prefer the py launcher, then python. If neither exists, print download guidance
REM and stop rather than auto-installing: a silent Python install needs admin rights
REM and leaves a hard-to-diagnose mess when it fails.
set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY (
    where python >nul 2>&1 && set "PY=python"
)

if not defined PY (
    echo [错误] 没有找到 Python / Python not found
    echo.
    echo 请先安装 Python 3.10 或更高版本：
    echo Please install Python 3.10 or newer:
    echo.
    echo     https://www.python.org/downloads/
    echo.
    echo 安装时务必勾选 "Add Python to PATH"
    echo Be sure to tick "Add Python to PATH" during installation
    echo.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in ('%PY% --version 2^>^&1') do set "PYVER=%%v"
echo [1/4] Python !PYVER!  ^(%PY%^)

REM ---------- 2. 检查 MT5Manager / check MT5Manager ----------
%PY% -c "import MT5Manager" >nul 2>&1
if errorlevel 1 (
    echo [2/4] 正在安装 MT5Manager... / installing MT5Manager...
    %PY% -m pip install --quiet --disable-pip-version-check MT5Manager
    if errorlevel 1 (
        echo.
        echo [错误] MT5Manager 安装失败 / installation failed
        echo.
        echo 请手动执行 / run manually:
        echo     %PY% -m pip install MT5Manager
        echo.
        echo 注意：MT5Manager 只支持 Windows 上的 64 位 Python。
        echo Note: MT5Manager requires 64-bit Python on Windows.
        echo.
        pause
        exit /b 1
    )
    echo       安装完成 / done
) else (
    echo [2/4] MT5Manager 已就绪 / ready
)

REM ---------- 3. 检查配置 / check configuration ----------
if not exist "!CFGDIR!config.ini" (
    if exist "!CFGDIR!config.ini.example" (
        copy /y "!CFGDIR!config.ini.example" "!CFGDIR!config.ini" >nul
        echo [3/4] 已生成 config.ini / config.ini created
        echo.
        echo ------------------------------------------------------------
        echo   首次运行，需要填写配置 / First run: configuration needed
        echo ------------------------------------------------------------
        echo.
        echo 即将打开 config.ini，请填写这两项：
        echo config.ini will open now; fill in these two fields:
        echo.
        echo   [manager] password  = MT5 管理员密码 / manager password
        echo   [backend] ea_token  = 与后端 EA_TOKEN 一致 / must match backend
        echo.
        echo 填好后保存并关闭记事本，本脚本会继续。
        echo Save and close Notepad, then this script continues.
        echo.
        pause
        notepad "!CFGDIR!config.ini"
    ) else (
        echo [错误] 缺少 config.ini 和 config.ini.example
        echo [error] both config.ini and config.ini.example are missing
        pause
        exit /b 1
    )
) else (
    echo [3/4] 配置文件已存在 / config.ini found
)

REM ---------- 4. 自检后启动 / self-check, then run ----------
echo [4/4] 正在自检连接与品种... / verifying connection and symbols...
echo.
%PY% -m manager_feed.main --check
if errorlevel 1 (
    echo.
    echo ------------------------------------------------------------
    echo   自检未通过，网关不会启动 / check failed, not starting
    echo ------------------------------------------------------------
    echo.
    echo 常见原因 / common causes:
    echo   - config.ini 里的密码或 ea_token 没填 / password or ea_token empty
    echo   - 服务器地址不对，或本机网络不通 / wrong server address or no network
    echo   - 品种名与券商实际名称不符 / symbol names don't match the broker
    echo.
    echo 详细日志见 logs\manager_feed.log
    echo See logs\manager_feed.log for details
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   自检通过，网关启动 / check passed, gateway starting
echo   按 Ctrl+C 停止 / press Ctrl+C to stop
echo ============================================================
echo.

REM 意外退出后自动重启：网络中断、服务器重启都可能让进程崩掉，
REM 而这个网关一停全站就没有行情，无人值守时必须能自己恢复。
REM Auto-restart after an unexpected exit: a network drop or server restart can kill
REM the process, and while it's down the whole site has no market data, so unattended
REM operation needs self-recovery.
:run
%PY% -m manager_feed.main
set "RC=!errorlevel!"
if "!RC!"=="0" goto done
echo.
echo [警告] 网关异常退出（代码 !RC!），10 秒后重启...
echo [warn] gateway exited unexpectedly (code !RC!), restarting in 10s...
timeout /t 10 /nobreak >nul
goto run

:done
echo.
echo 网关已停止 / gateway stopped
pause
