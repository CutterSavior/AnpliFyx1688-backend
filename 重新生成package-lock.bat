@echo off
chcp 65001 >nul
echo ========================================
echo 重新生成 package-lock.json
echo ========================================
echo.

cd /d "%~dp0"

echo 1. 刪除舊的 package-lock.json...
if exist package-lock.json del package-lock.json

echo.
echo 2. 刪除 node_modules...
if exist node_modules rmdir /s /q node_modules

echo.
echo 3. 重新安裝所有依賴（包括 ethers）...
npm install

echo.
echo 4. 驗證 ethers 是否已安裝...
npm list ethers

echo.
echo ========================================
echo ✅ 完成！
echo ========================================
echo.
echo 請執行以下命令推送到 GitHub：
echo.
echo cd ..
echo git add backend/package-lock.json
echo git commit -m "chore: 重新生成 package-lock.json 包含 ethers 依賴"
echo git push origin main
echo.
pause

