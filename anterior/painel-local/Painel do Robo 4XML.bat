@echo off
rem Abre o painel do robo do 4XML no navegador.
title Robo do 4XML
cd /d "%~dp0"
node painel.mjs
if errorlevel 1 (
  echo.
  echo Nao consegui abrir o painel. Confira se o Node esta instalado: node -v
  pause
)
