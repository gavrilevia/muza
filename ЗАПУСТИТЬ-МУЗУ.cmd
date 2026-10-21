@echo off
title Muza - dev server
echo ============================================
echo   Muza: starting dev server
echo   Stop: press Ctrl+C in this window
echo ============================================
echo.
wsl.exe -- bash -lc "cd ~/projects/*/muza && npm run dev"
echo.
echo Server stopped. Press any key to close.
pause >nul
