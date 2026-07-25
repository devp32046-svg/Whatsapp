@echo off
title CGPE PDF Prep - keep this window open
cd /d "%~dp0"
echo ============================================================
echo   CGPE PDF Prep Service
echo   Big claim PDFs (over 20 MB) get split and analysed.
echo   Keep this window OPEN while you want the feature on.
echo   Close it (or press Ctrl+C) to turn it off safely.
echo ============================================================
echo.
node pdf-prep-launcher.js
echo.
echo Service stopped. You can close this window.
pause
