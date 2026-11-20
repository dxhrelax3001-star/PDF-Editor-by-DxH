@echo off
rem Chay may chu PDF Editor (cong 3300) va mo trong Chrome
cd /d "%~dp0"
netstat -ano | findstr ":3300 " | findstr LISTENING >nul
if errorlevel 1 start "PDF Editor server" /min "C:\Program Files\nodejs\node.exe" server.js
timeout /t 1 /nobreak >nul
start chrome http://localhost:3300
