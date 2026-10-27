@echo off
setlocal EnableExtensions DisableDelayedExpansion
echo For normal use, run the supplied Setup.exe or Patch.exe.
echo The 0.2.0 build uses Python, GCC and GNU ld in a Linux development environment.
echo Opening the documented build instructions.
start "" "%~dp0docs\BUILD.html"
exit /b 0
