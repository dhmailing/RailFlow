@echo off
chcp 65001 >nul
echo == RailFlow Agent 중단 ==
echo.
echo 감시 중인 창에서 Ctrl+C 를 누르는 것이 가장 확실합니다.
echo 창을 이미 닫았거나 반응이 없으면 아래에서 강제로 종료합니다.
echo.
set /p YN="지금 강제 종료할까요? (y/N): "
if /i not "%YN%"=="y" exit /b 0
taskkill /FI "WINDOWTITLE eq railflow-agent*" /T /F >nul 2>&1
for /f "tokens=2" %%p in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST ^| findstr PID') do echo node.exe PID %%p
echo.
echo 위 목록에서 RailFlow Agent 를 실행한 node.exe 를 작업 관리자에서 종료해 주세요.
pause
