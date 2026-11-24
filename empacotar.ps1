# Monta o pacote que as máquinas baixam do portal.
#
#   powershell -ExecutionPolicy Bypass -File robo-4xml\empacotar.ps1
#
# Entra no pacote só o que a máquina precisa para trabalhar: o robô, o
# agente e o playwright-core. Fora ficam os diários, os segredos, a
# identidade da máquina e tudo que era do painel local (a tela 3D, o three,
# o calibrador) - são 9 MB de coisa que ninguém vai abrir lá.
#
# O pacote é publicado junto com o portal, em public\robo\. O portal não o
# serve para o mundo: ele sai só por /api/robo/pacote.zip, com convite ou
# token do agente.
$ErrorActionPreference = 'Stop'
$robo = Split-Path -Parent $MyInvocation.MyCommand.Path
$raiz = Split-Path -Parent $robo
$saida = Join-Path $raiz 'public\robo'
$temp = Join-Path $env:TEMP ('robo-pacote-' + [guid]::NewGuid().ToString('N'))

# A versão é a do robô, lida do próprio código: uma verdade só. É por ela que
# o agente descobre que está atrasado e se atualiza sozinho.
$fonte = Get-Content (Join-Path $robo 'robo.mjs') -Raw
if ($fonte -notmatch 'export const VERSAO = "([^"]+)"') { throw "Nao achei a VERSAO em robo.mjs" }
$versao = $Matches[1]
Write-Host "versao do robo: $versao" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $temp, $saida | Out-Null
try {
  foreach ($arquivo in 'robo.mjs', 'agente.mjs', 'segredos.mjs', 'periodo.mjs', 'desinstalar.ps1', 'config.json', 'package.json', 'LEIAME.md') {
    Copy-Item (Join-Path $robo $arquivo) $temp
  }
  $destinoDep = Join-Path $temp 'node_modules\playwright-core'
  New-Item -ItemType Directory -Force -Path $destinoDep | Out-Null
  Copy-Item (Join-Path $robo 'node_modules\playwright-core\*') $destinoDep -Recurse -Force

  $zip = Join-Path $saida 'pacote.zip'
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $temp '*') -DestinationPath $zip -CompressionLevel Optimal

  [IO.File]::WriteAllText((Join-Path $saida 'versao.json'),
    (@{ versao = $versao; em = (Get-Date).ToString('s') } | ConvertTo-Json -Compress))

  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "pacote.zip: $mb MB" -ForegroundColor Green
  Write-Host "publique com: npm run deploy"
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
