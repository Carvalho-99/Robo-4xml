# Tira o robô deste computador.
#
#   powershell -ExecutionPolicy Bypass -File desinstalar.ps1          pausa
#   powershell -ExecutionPolicy Bypass -File desinstalar.ps1 -Tudo    remove
#
# Sem -Tudo: o agente para de entrar sozinho e sai do ar. O computador some
# da aba Robô do portal depois de um minuto, mas a pasta, as credenciais e os
# diários continuam onde estão - rodar o instalador de novo religa tudo.
#
# Com -Tudo: apaga também as credenciais e a identidade da máquina. A pasta
# em si não é apagada: os diários moram nela, e essa decisão é sua.
param([switch]$Tudo)

$ErrorActionPreference = 'Continue'
$tarefa = 'Robo 4XML'
$pasta = Join-Path $env:LOCALAPPDATA 'Robo4XML'
# Rodando de dentro da pasta instalada, é ela que vale.
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path $aqui 'agente.mjs')) { $pasta = $aqui }

Write-Host "== Desligando o robo do 4XML ==" -ForegroundColor Cyan
Write-Host "pasta: $pasta"
Write-Host "conta: $env:USERDOMAIN\$env:USERNAME"

# 1. o agendamento (o nome antigo também, para quem instalou na mão)
foreach ($nome in $tarefa, 'Robo 4XML - NF-e 55 para o portal') {
  if (Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $nome -Confirm:$false
    Write-Host "  tarefa '$nome' removida" -ForegroundColor Green
  }
}

# 2. o que estiver rodando agora: o agente, o robô e o painel antigo
$vivos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*agente.mjs*' -or $_.CommandLine -like '*robo.mjs*' -or $_.CommandLine -like '*painel.mjs*' }
if ($vivos) {
  $vivos | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "  encerrei $(@($vivos).Count) processo(s)" -ForegroundColor Green
} else {
  Write-Host "  nada estava rodando"
}

if (-not $Tudo) {
  Write-Host ""
  Write-Host "Pausado. As credenciais e os diarios continuam na pasta." -ForegroundColor Yellow
  Write-Host "Para voltar: baixe o instalador na aba Robo do portal e rode de novo."
  return
}

# 3. credenciais e identidade
foreach ($arquivo in 'senha.dat', 'token.dat', 'maquina.json', 'agenda.json') {
  $caminho = Join-Path $pasta $arquivo
  if (Test-Path $caminho) { Remove-Item $caminho -Force; Write-Host "  $arquivo apagado" -ForegroundColor Green }
}

# 4. atalho da area de trabalho do painel antigo
$atalho = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Robo do 4XML.lnk'
if (Test-Path $atalho) { Remove-Item $atalho -Force; Write-Host "  atalho antigo removido" -ForegroundColor Green }

Write-Host ""
Write-Host "Removido. A senha do Protheus e o token do portal nao existem mais aqui." -ForegroundColor Green
Write-Host "A pasta $pasta continua, com os diarios em logs\."
Write-Host "No portal, a maquina fica na lista como 'sem contato' ate voce apaga-la de la."
