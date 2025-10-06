@echo off
echo ==========================================
echo 部署新API功能到 api.andy123.net
echo ==========================================

echo 正在更新後端API功能...

REM 檢查Node.js是否安裝
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo 錯誤: 未安裝Node.js，請先安裝Node.js
    pause
    exit /b 1
)

echo 1. 檢查依賴包...
if not exist node_modules (
    echo 安裝依賴包...
    npm install
) else (
    echo 依賴包已存在
)

echo 2. 重啟後端服務...
echo 正在重啟Node.js服務...

REM 停止現有服務（如果有的話）
taskkill /f /im node.exe >nul 2>&1

REM 啟動新服務
echo 啟動新的API服務...
start "API Server" cmd /k "node index.js"

echo 3. 等待服務啟動...
timeout /t 5 /nobreak >nul

echo 4. 測試API接口...
echo 測試WebSocket信息接口...
curl -s http://localhost:3000/api/ws/info >nul
if %errorlevel% equ 0 (
    echo ✅ WebSocket信息接口正常
) else (
    echo ❌ WebSocket信息接口異常
)

echo 測試K線數據接口...
curl -s "http://localhost:3000/api/kline?symbol=BTCUSDT" >nul
if %errorlevel% equ 0 (
    echo ✅ K線數據接口正常
) else (
    echo ❌ K線數據接口異常
)

echo 測試訂單簿接口...
curl -s "http://localhost:3000/api/orderbook?symbol=BTCUSDT" >nul
if %errorlevel% equ 0 (
    echo ✅ 訂單簿接口正常
) else (
    echo ❌ 訂單簿接口異常
)

echo 測試成交記錄接口...
curl -s "http://localhost:3000/api/trades?symbol=BTCUSDT" >nul
if %errorlevel% equ 0 (
    echo ✅ 成交記錄接口正常
) else (
    echo ❌ 成交記錄接口異常
)

echo ==========================================
echo 部署完成！
echo ==========================================
echo.
echo 新增的API接口：
echo - GET  /api/ws/info          - WebSocket信息
echo - POST /api/ws/push          - WebSocket數據推送
echo - GET  /api/ws/simulate      - 模擬數據生成
echo - GET  /api/kline            - K線數據
echo - GET  /api/orderbook        - 訂單簿數據
echo - GET  /api/trades           - 成交記錄
echo - GET  /api/orders/current   - 當前委託
echo - GET  /api/orders/history   - 歷史訂單
echo - GET  /api/price            - 價格數據
echo - GET  /api/user/info        - 用戶信息
echo - GET  /api/user/balance     - 用戶餘額
echo - POST /api/trade/place      - 下單
echo - POST /api/trade/cancel     - 取消訂單
echo - GET  /api/trade/positions  - 持倉信息
echo.
echo 服務地址: http://localhost:3000
echo 前端現在可以正常連接並獲取數據了！
echo.
pause
