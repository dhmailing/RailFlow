@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo == RailFlow Agent 설치 ==
echo.
echo Node.js 가 설치되어 있어야 합니다. (https://nodejs.org 의 LTS 버전)
node --version || (echo Node.js 를 찾지 못했습니다. 먼저 설치해 주세요. & pause & exit /b 1)
echo.
echo 필요한 파일을 내려받는 중입니다. 몇 분 걸릴 수 있습니다...
call npm install || (echo 설치에 실패했습니다. & pause & exit /b 1)
call npx playwright install chromium || (echo 브라우저 설치에 실패했습니다. & pause & exit /b 1)
echo.
echo 설치가 끝났습니다. 다음으로 "2-화면기록.cmd" 를 실행하세요.
pause
