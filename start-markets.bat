@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Polymarket markets server...
echo   全部市场: http://localhost:3457/polymarket_active_markets.html
echo   加密5分钟: http://localhost:3457/polymarket_crypto_5m.html
echo   加密15分钟: http://localhost:3457/polymarket_crypto_15m.html
echo   交易列表:   http://localhost:3457/polymarket_traders.html
node markets-server.mjs
pause
