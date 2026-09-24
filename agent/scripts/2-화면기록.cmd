@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo == 공식 예매 화면 기록(최초 1회) ==
echo.
set /p SITE="공식 예매 화면 주소를 붙여넣고 Enter: "
node railflow-agent.mjs capture --url "%SITE%"
pause
