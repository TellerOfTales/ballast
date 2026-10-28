@echo off
rem Entry point that BallastSetup.exe (IExpress) runs from its extraction folder.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
