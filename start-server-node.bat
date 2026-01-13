@echo off
echo ========================================
echo   MekanApp - Node.js Web Sunucusu
echo ========================================
echo.
echo Bilgisayarinizin IP adresini bulun:
ipconfig | findstr /i "IPv4"
echo.
echo Android tabletnizden su adresi acin:
echo http://[IP-ADRESINIZ]:8000
echo.
echo Sunucuyu durdurmak icin Ctrl+C basin
echo ========================================
echo.

npx --yes http-server -p 8000 -o
if errorlevel 1 (
    echo.
    echo HATA: Node.js bulunamadi!
    echo Lutfen Node.js yukleyin: https://nodejs.org
    echo.
    pause
)