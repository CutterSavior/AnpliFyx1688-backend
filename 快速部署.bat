@echo off
chcp 65001 >nul
echo ============================================
echo    快速部署後端到 Render
echo ============================================
echo.

echo [1/3] 添加修改的文件...
git add index.js

echo [2/3] 提交更改...
git commit -m "✅ 添加移動端API + 心跳機制防休眠"

echo [3/3] 推送到 GitHub...
git push

echo.
echo ============================================
echo    推送完成！
echo    請等待 Render 重新部署 (約3-5分鐘)
echo ============================================
echo.
echo 部署狀態查看: https://dashboard.render.com
echo.
pause

