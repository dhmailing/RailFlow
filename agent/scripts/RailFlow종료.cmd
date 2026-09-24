@echo off
chcp 65001 >nul
title RailFlow 종료
echo.
echo ================================================
echo   RailFlow 실제 연동 - 종료
echo ================================================
echo.
echo   가장 확실한 방법은 "RailFlow 실제 연동" 창에서
echo   Ctrl+C 를 누르는 것입니다.
echo.
echo   창을 이미 닫았거나 반응이 없을 때만 아래를 진행하세요.
echo.
set /p YN="지금 RailFlow 창을 강제로 닫을까요? (y/N): "
if /i not "%YN%"=="y" exit /b 0

rem 이번에 실행한 RailFlow 창만 닫는다. 다른 Node.js 프로그램은 건드리지 않는다.
taskkill /FI "WINDOWTITLE eq RailFlow 실제 연동*" /T /F >nul 2>&1
if errorlevel 1 (
  echo.
  echo   실행 중인 RailFlow 창을 찾지 못했습니다. 이미 종료된 것 같습니다.
) else (
  echo.
  echo   RailFlow 를 종료했습니다.
)
echo.
pause
