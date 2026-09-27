@echo off

title Livrinhos de Colorir

cd /d "%~dp0"

rem Se o servico ja estiver rodando, so abre o app. Senao, liga o servidor nesta janela.

powershell -NoProfile -Command "$t = New-Object Net.Sockets.TcpClient; try { if ($t.ConnectAsync('127.0.0.1', 8765).Wait(1000) -and $t.Connected) { exit 0 } } catch {}; exit 1"

if errorlevel 1 (

  python server.py

  if errorlevel 1 pause

) else (

  start "" msedge --app=http://localhost:8765

)

