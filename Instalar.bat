@echo off
rem Instala o Livrinhos neste PC: liga junto com o Windows, libera o celular no firewall
rem e cria o icone na area de trabalho. Pede permissao de administrador.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalador\instalar.ps1"
