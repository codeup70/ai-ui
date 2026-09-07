@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not in PATH.
  echo Please install Node.js from https://nodejs.org/ and then run npm install.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules" (
  echo Dependencies are not installed yet.
  echo Run this first: npm install
  pause
  exit /b 1
)

start "" "http://localhost:3000"
cd /d "%~dp0"
npm start
