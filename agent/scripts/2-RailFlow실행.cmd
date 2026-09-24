@echo off
chcp 65001 >nul
title RailFlow 실제 연동 (이 창을 닫으면 멈춥니다)
cd /d "%~dp0.."

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 를 찾지 못했습니다. 먼저 "1-설치.cmd" 를 실행해 주세요.
  pause
  exit /b 1
)

echo.
echo ================================================
echo   RailFlow 실제 연동 - 실행
echo.
echo   이 창은 RailFlow 를 돌리는 창입니다.
echo   조회가 끝날 때까지 닫지 마세요.
echo.
echo   잠시 뒤 인터넷 브라우저가 자동으로 열립니다.
echo ================================================
echo.

node railflow-agent.mjs start
echo.
echo RailFlow 가 종료됐습니다.
pause
