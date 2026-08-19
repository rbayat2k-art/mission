@echo off
setlocal
cd /d "%~dp0"

if not exist .env (
  echo [ERROR] File .env does not exist.
  echo Copy .env.example to .env and enter your MySQL information.
  pause
  exit /b 1
)

if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)

call npm run db:migrate
if errorlevel 1 exit /b 1

echo Open http://127.0.0.1:3000
call npm run dev
