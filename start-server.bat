@echo off
echo ========================================
echo   MekanApp - Web Sunucusu Baslatiliyor
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

python -m http.server 8000
if errorlevel 1 (
    echo.
    echo HATA: Python bulunamadi!
    echo Python yuklu degilse asagidaki alternatifleri kullanin:
    echo.
    echo Alternatif 1: Node.js ile
    echo   npx http-server -p 8000
    echo.
    echo Alternatif 2: PHP ile (varsa)
    echo   php -S 0.0.0.0:8000
    echo.
    pause
)