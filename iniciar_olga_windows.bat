@echo off
setlocal
cd /d "%~dp0"
if "%GEMINI_API_KEY%"=="" (
  set /p GEMINI_API_KEY=Pegá tu API key de Gemini para esta sesión: 
)
if "%GEMINI_API_KEY%"=="" (
  echo No se ingresó una API key.
  pause
  exit /b 1
)
set PORT=8787
set HOST=127.0.0.1
set ALLOWED_ORIGIN=http://localhost:8787
node olga_gemini_proxy.mjs
pause
