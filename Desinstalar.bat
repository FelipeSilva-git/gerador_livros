@echo off
rem Remove o servico, o firewall e os icones. Os livros (historias.db) NAO sao apagados.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalador\desinstalar.ps1"
