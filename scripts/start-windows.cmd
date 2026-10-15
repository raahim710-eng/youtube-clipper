@echo off
rem One-click start for Windows (DEPLOYMENT.md): runs the production build of the app and both workers.
rem Double-click this file, or make a desktop shortcut to it. Close the window to stop everything.
cd /d "%~dp0\.."
if not exist ".next\BUILD_ID" (
  echo The app hasn't been built yet. Running "npm run build" first - this takes a few minutes...
  call npm run build || goto :failed
)
echo Starting Creator Studio Assistant. Open http://localhost:3000 in your browser.
echo Keep this window open while you use the app; close it to stop the app.
start "" /b cmd /c "timeout /t 20 /nobreak >nul && start "" http://localhost:3000"
call npm run start:all
goto :eof

:failed
echo.
echo The build failed. Run "npm run build" in a terminal to see why (see DEPLOYMENT.md, Troubleshooting).
pause
