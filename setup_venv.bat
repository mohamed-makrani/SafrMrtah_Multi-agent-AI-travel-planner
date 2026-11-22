@echo off
REM ==================================================================
REM TripMate AI - rebuild the virtual environment on THIS computer
REM
REM The old .venv was copied from another PC (C:\Users\HP\...) and
REM points to a Python that does not exist here. A venv cannot be moved
REM between machines, so this script recreates it.
REM ==================================================================
cd /d "%~dp0"

REM --- Find a Python on this machine (3.13 preferred, then 3.12, 3.11) ---
set "BASEPY="
for %%V in (3.13 3.12 3.11) do (
  if not defined BASEPY (
    py -%%V -c "import sys" >nul 2>&1 && set "BASEPY=py -%%V"
  )
)
if not defined BASEPY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "BASEPY="%LOCALAPPDATA%\Programs\Python\Python313\python.exe""
if not defined BASEPY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "BASEPY="%LOCALAPPDATA%\Programs\Python\Python312\python.exe""
if not defined BASEPY if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "BASEPY="%LOCALAPPDATA%\Programs\Python\Python311\python.exe""
if not defined BASEPY (
  echo No Python 3.11+ found on this computer. Install Python from python.org and run this again.
  pause
  exit /b 1
)
echo Using base Python: %BASEPY%
%BASEPY% --version

REM --- Keep the broken venv aside instead of deleting it ---
if exist ".venv" (
  if exist ".venv_old_HP" rmdir /s /q ".venv_old_HP"
  ren ".venv" ".venv_old_HP"
  echo Old environment renamed to .venv_old_HP - you can delete it later.
)

%BASEPY% -m venv .venv || (echo Could not create .venv & pause & exit /b 1)

".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt || (echo Dependency install failed & pause & exit /b 1)

REM --- Pre-install the AviationStack MCP tool (uv brings its own Python 3.13 if needed) ---
".venv\Scripts\python.exe" -c "import aviationstack_mcp" >nul 2>&1
if errorlevel 1 (
  echo Installing AviationStack MCP tool with uv...
  ".venv\Scripts\uv.exe" tool install aviationstack-mcp
)

echo.
echo Done. Start the app with run_local.bat
pause
