@echo off
title Livrinhos de Colorir
cd /d "%~dp0"
python server.py
if errorlevel 1 pause
