@echo off
title Ballast
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
node src\server.mjs %*
pause
