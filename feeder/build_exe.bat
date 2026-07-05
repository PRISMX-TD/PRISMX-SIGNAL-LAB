@echo off
REM 一键构建单文件喂价器 exe / One-click build of the single-file feeder exe.
REM 在装了 Python 的 Windows 机器上（不必是最终部署的 VPS）双击运行本脚本，
REM 产物在 dist\PRISMX-Chart-Feeder.exe，拷到 VPS 配上 feeder_config.json 即可用。
REM Double-click on any Windows machine with Python installed (doesn't have
REM to be the deployment VPS). Output lands at dist\PRISMX-Chart-Feeder.exe;
REM copy it to the VPS alongside a feeder_config.json and it's ready to run.
cd /d "%~dp0"

if not exist .venv (
    echo Creating build virtual environment...
    python -m venv .venv
)

echo Installing dependencies...
.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
.venv\Scripts\python.exe -m pip install --quiet -r requirements.txt pyinstaller

echo Building PRISMX-Chart-Feeder.exe...
.venv\Scripts\python.exe -m PyInstaller --onefile --console --name PRISMX-Chart-Feeder --distpath dist --workpath build --specpath . chart_feeder.py

echo.
echo Done. The executable is at: dist\PRISMX-Chart-Feeder.exe
pause
