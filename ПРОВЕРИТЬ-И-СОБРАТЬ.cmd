@echo off
title Muza - check and build
echo ============================================
echo   Muza: type check and build
echo ============================================
echo.
wsl.exe -- bash -lc "cd ~/projects/*/muza && npm run check && npm run build"
echo.
echo Done. Press any key to close.
pause >nul
