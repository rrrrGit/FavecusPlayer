@echo off
setlocal EnableExtensions DisableDelayedExpansion
if exist "%~dp0FavecusPlayer.exe" (
  start "" "%~dp0FavecusPlayer.exe"
  exit /b 0
)
if exist "%~dp0Setup.exe" (
  start "" "%~dp0Setup.exe"
  exit /b 0
)
echo Run the supplied Focus-Player-Setup.exe or Patch.exe to install Favecus Player.
echo The source archive is for development. See README.md.
pause
exit /b 1
