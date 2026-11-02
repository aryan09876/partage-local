@echo off
rem Lanceur Windows : partage install ^| status ^| logs ^| set port 8080 ^| help
where node >nul 2>nul || (echo Node.js 20 ou plus recent est necessaire : https://nodejs.org & exit /b 1)
node "%~dp0manage.js" %*
