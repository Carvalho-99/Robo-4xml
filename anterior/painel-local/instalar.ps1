# Instala o robo do 4XML na maquina do fiscal: dependencia, segredos e a
# tarefa agendada das 08:00 e das 17:00.
#
#   powershell -ExecutionPolicy Bypass -File instalar.ps1
#
# A tarefa roda com a conta de quem instalou, e so quando essa pessoa esta
# logada - e o que o robo precisa: a senha so se decifra na conta dela, e o
# Protheus roda na sessao dela. Se o computador estiver desligado as 08:00,
# -StartWhenAvailable faz a tarefa rodar assim que ele ligar.
$ErrorActionPreference = 'Stop'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$tarefa = 'Robo 4XML - NF-e 55 para o portal'

Write-Host "== Robo do 4XML ==" -ForegroundColor Cyan
Write-Host "pasta: $pasta"

# 1. Node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js nao encontrado. Instale o Node 22 LTS e rode de novo." }
Write-Host "node:  $node"

# 2. Dependencia (playwright-core; o navegador e o Edge que ja existe no Windows)
Push-Location $pasta
try {
  if (-not (Test-Path (Join-Path $pasta 'node_modules\playwright-core'))) {
    Write-Host "instalando a dependencia..."
    & npm install --omit=dev --no-audit --no-fund | Out-Null
  }
} finally { Pop-Location }

# 3. Segredos
if (-not (Test-Path (Join-Path $pasta 'senha.dat'))) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $pasta 'guardar-senha.ps1')
}

# 4. Tarefa agendada
$acao = New-ScheduledTaskAction -Execute $node -Argument 'robo.mjs' -WorkingDirectory $pasta
$gatilhos = @(
  (New-ScheduledTaskTrigger -Daily -At '08:00'),
  (New-ScheduledTaskTrigger -Daily -At '17:00')
)
$config = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew
$quem = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

if (Get-ScheduledTask -TaskName $tarefa -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $tarefa -Confirm:$false
}
Register-ScheduledTask -TaskName $tarefa -Action $acao -Trigger $gatilhos `
  -Settings $config -Principal $quem `
  -Description 'Sincroniza o Espiao XML do 4XML com a SEFAZ e manda as NF-e 55 ao portal de recebimento de notas.' | Out-Null

# 5. Atalho do painel na area de trabalho
$bat = Join-Path $pasta 'Painel do Robo 4XML.bat'
if (Test-Path $bat) {
  $atalho = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Robo do 4XML.lnk'
  $w = New-Object -ComObject WScript.Shell
  $l = $w.CreateShortcut($atalho)
  $l.TargetPath = $bat
  $l.WorkingDirectory = $pasta
  $l.Description = 'Abre o painel do robo do 4XML'
  $l.IconLocation = "$env:SystemRoot\System32\shell32.dll,44"
  $l.Save()
  Write-Host "  atalho 'Robo do 4XML' criado na area de trabalho"
}

Write-Host ""
Write-Host "Pronto. A tarefa '$tarefa' roda as 08:00 e as 17:00." -ForegroundColor Green
Write-Host "Para mudar horarios, ou mandar buscar agora, use o atalho da area de trabalho."

Write-Host "Para testar agora, sem mexer em nada:"
Write-Host "  node robo.mjs --so-colher --seco --visivel"
Write-Host "Para rodar o ciclo completo a mao:"
Write-Host "  Start-ScheduledTask -TaskName '$tarefa'"
Write-Host "O diario fica em $pasta\logs."
