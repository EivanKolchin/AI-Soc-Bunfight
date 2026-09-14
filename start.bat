@echo off
setlocal
title AI Society - bunfight stall

cd /d "%~dp0"

echo.
echo   ==================================================
echo    AI SOCIETY  -  BUNFIGHT STALL
echo   ==================================================
echo.

if not exist "index.html" (
  echo   ERROR: index.html not found next to this file.
  echo   Keep start.bat inside the bunfight folder.
  echo.
  pause
  exit /b 1
)

rem ---- find a working Python -------------------------------------------
rem  py -3 is tried first: on Windows a bare "python" is often the Microsoft
rem  Store stub, which opens the Store instead of running anything.
set "PY="

py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=py -3"

if not defined PY (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)

if not defined PY (
  python3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=python3"
)

if not defined PY (
  echo   ERROR: Python was not found on this machine.
  echo.
  echo   Install it from  https://www.python.org/downloads/
  echo   and TICK "Add python.exe to PATH" during setup.
  echo.
  echo   If Python IS installed and you still see this, Windows is
  echo   probably intercepting it. Settings - Apps - Advanced app
  echo   settings - App execution aliases, and turn OFF both
  echo   "App Installer  python.exe" entries.
  echo.
  pause
  exit /b 1
)

rem ---- find a free port -------------------------------------------------
set PORT=8124
:checkport
netstat -an | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul
if errorlevel 1 goto gotport
set /a PORT=%PORT%+1
if %PORT% LEQ 8140 goto checkport
echo   ERROR: every port from 8124 to 8140 is already in use.
echo   Close any other server window and try again.
echo.
pause
exit /b 1
:gotport

rem ---- pick a browser ----------------------------------------------------
rem  The stall gets its OWN browser profile, in its own browser process.
rem  Your everyday profile can have WebGL switched off for reasons that have
rem  nothing to do with this folder: acceleration turned off, a privacy
rem  extension blocking canvas, or - what actually happened during
rem  development - a GPU process that crashed once and stayed off for the
rem  rest of a 56-hour browser session. A fresh profile means a fresh GPU
rem  process, every time.
rem
rem  Batch gotcha: %ProgramFiles(x86)% cannot appear inside a for (...) list,
rem  the ")" in its name ends the list early. Copy it first.
set "PF86=%ProgramFiles(x86)%"
set "PF=%ProgramFiles%"
set "BROWSER="
for %%B in (
  "%PF86%\Microsoft\Edge\Application\msedge.exe"
  "%PF%\Microsoft\Edge\Application\msedge.exe"
  "%PF%\Google\Chrome\Application\chrome.exe"
  "%PF86%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%PF%\Chromnius\Application\chromnius.exe"
) do if not defined BROWSER if exist %%B set "BROWSER=%%~B"

set "PROFILE=%LocalAppData%\bunfight-browser"
set "URL=http://localhost:%PORT%/"
if defined BUNFIGHT_URL set "URL=%BUNFIGHT_URL%"

rem  --disable-gpu-process-crash-limit : one driver hiccup must not switch
rem                                      WebGL off for the whole day
rem  --enable-unsafe-swiftshader       : software WebGL as a last resort; it
rem                                      does NOT demote a working GPU
rem  (no --use-fake-ui-for-media-stream: Edge puts an "unsupported flag /
rem   security risk" banner across the top of the window for it. Click Allow
rem   once instead - the stall profile remembers it.)
rem  --app=                            : a plain window, no tabs or address bar
set FLAGS=--user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check
set FLAGS=%FLAGS% --disable-gpu-process-crash-limit --enable-unsafe-swiftshader
set FLAGS=%FLAGS% --autoplay-policy=no-user-gesture-required
set FLAGS=%FLAGS% --disable-session-crashed-bubble --start-maximized
if defined BUNFIGHT_DEBUGPORT set FLAGS=%FLAGS% --remote-debugging-port=%BUNFIGHT_DEBUGPORT%

echo   Python:  %PY%
echo   Folder:  %CD%
echo   Port:    %PORT%
if defined BROWSER (
  echo   Browser: "%BROWSER%"
  echo   Profile: %PROFILE%
  echo            dedicated to the stall - your normal browser is untouched
) else (
  echo   Browser: none of Edge / Chrome / Chromnius found - using the default
  echo            browser. If WebGL fails there, install Edge or Chrome.
)
echo.
echo   --------------------------------------------------
echo     STALL SHELL .... http://localhost:%PORT%/
echo   --------------------------------------------------
echo     Mood detector .. http://localhost:%PORT%/demos/mood.html
echo     Air pictionary . http://localhost:%PORT%/demos/pictionary.html
echo.
echo     Browser check .. http://localhost:%PORT%/shared/delegate-test.html
echo     Tongue test .... http://localhost:%PORT%/shared/tongue-test.html
echo     Sketch test .... http://localhost:%PORT%/shared/sketch-test.html
echo   --------------------------------------------------
echo.
echo   Press 1 / 2 in the page to switch demos.  F = fullscreen.
echo   Click Allow the first time it asks for the camera - the stall
echo   profile remembers it after that.
echo.
echo   ** CLOSE THIS WINDOW TO STOP THE SERVER **
echo.

rem  Open the browser a couple of seconds after the server is listening.
rem  Done through a tiny helper script so the browser command line, which is
rem  full of quotes, does not have to survive cmd /c quote-stripping.
set "OPENER=%TEMP%\bunfight-open.cmd"
> "%OPENER%" echo @ping -n 3 127.0.0.1 ^>nul
if defined BROWSER (
  >> "%OPENER%" echo @start "" "%BROWSER%" %FLAGS% --app=%URL%
) else (
  >> "%OPENER%" echo @start "" %URL%
)
start "" /b "%OPENER%"

%PY% -m http.server %PORT%

echo.
echo   Server stopped.
pause