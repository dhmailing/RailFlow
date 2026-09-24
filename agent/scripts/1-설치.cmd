@echo off
chcp 65001 >nul
title RailFlow 설치
cd /d "%~dp0.."
echo.
echo ================================================
echo   RailFlow 실제 연동 - 설치 (처음 한 번만)
echo ================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [필요한 프로그램이 없습니다]
  echo.
  echo   Node.js 가 설치되어 있지 않습니다.
  echo.
  echo   1^) 인터넷 브라우저에서 https://nodejs.org 로 이동하세요.
  echo   2^) 왼쪽의 "LTS" 라고 적힌 큰 버튼을 눌러 내려받으세요.
  echo   3^) 내려받은 파일을 실행하고 [다음]만 계속 누르면 됩니다.
  echo   4^) 설치가 끝나면 컴퓨터를 다시 시작한 뒤 이 파일을 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODEVER=%%v
echo   Node.js %NODEVER% 를 찾았습니다.
echo.
echo   필요한 파일을 내려받습니다. 인터넷 속도에 따라 몇 분 걸립니다.
echo   창을 닫지 말고 기다려 주세요.
echo.

call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [설치 실패] 인터넷 연결이나 회사 보안 프로그램 때문일 수 있습니다.
  echo 아래 내용을 그대로 복사해 전달해 주세요.
  echo.
  pause
  exit /b 1
)

call npx playwright install chromium
if errorlevel 1 (
  echo.
  echo [브라우저 설치 실패] 위 내용을 그대로 복사해 전달해 주세요.
  echo.
  pause
  exit /b 1
)

echo.
node railflow-agent.mjs doctor
echo.
echo ================================================
echo   설치가 끝났습니다.
echo   다음으로 "2-RailFlow실행.cmd" 를 실행하세요.
echo ================================================
echo.
pause
