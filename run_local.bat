@echo off
REM TripMate AI - local launcher
REM 1) checks the project environment (.venv)
REM 2) starts the remote weather MCP server in its own window
REM 3) starts the TripMate app on http://127.0.0.1:8000
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo .venv is missing. Run setup_venv.bat first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -c "import sys" >nul 2>&1
if errorlevel 1 (
  echo .venv is broken ^(created on another computer^). Run setup_venv.bat first.
  pause
  exit /b 1
)

set "PY=.venv\Scripts\python.exe"

"%PY%" -c "import fastapi, langgraph, mcp, uv" 2>nul
if errorlevel 1 (
  echo Installing missing dependencies...
  "%PY%" -m pip install -r requirements.txt
)

start "TripMate Weather MCP" cmd /k ""%PY%" custom_weather_mcp_server.py"
timeout /t 3 /nobreak >nul
"%PY%" app.py
