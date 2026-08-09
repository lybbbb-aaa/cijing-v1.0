@echo off
cd /d C:\Users\liuyb07\Desktop\project\ielts-vocab
echo.
echo === 词境 v1.0 - 推送到 GitHub ===
echo.
"C:\Program Files\Git\bin\git.exe" push -u origin master
echo.
echo 如果上面显示 "Everything up-to-date" 或成功信息，说明推送完成了！
echo 如果弹出登录窗口，用你的 GitHub 账号登录即可。
echo.
pause
