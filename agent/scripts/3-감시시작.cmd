@echo off
chcp 65001 >nul
cd /d "%~dp0.."
node railflow-agent.mjs check || (echo. & echo 프로필을 먼저 완성해 주세요. "2-화면기록.cmd" 를 실행한 뒤 안내대로 파일을 채우면 됩니다. & pause & exit /b 1)
echo.
node railflow-agent.mjs watch
pause
