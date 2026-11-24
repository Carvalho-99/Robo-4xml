# Guarda a senha do Protheus e o token do portal cifrados pelo DPAPI do
# Windows. O arquivo gerado so pode ser lido pela MESMA conta de usuario
# NESTA maquina: copiar para outro lugar nao adianta nada a ninguem.
#
#   powershell -ExecutionPolicy Bypass -File guardar-senha.ps1
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path

# Grava sem BOM e sem quebra de linha no fim: o Set-Content -Encoding utf8
# do PowerShell 5.1 poe os dois, e o ConvertTo-SecureString recusa a cadeia
# na hora de ler de volta.
function Gravar($segredo, $arquivo) {
  $texto = $segredo | ConvertFrom-SecureString
  [IO.File]::WriteAllText((Join-Path $pasta $arquivo), $texto, [Text.UTF8Encoding]::new($false))
  Write-Host "  $arquivo gravado"
}

Write-Host "Senha do Protheus (nao aparece na tela):"
Gravar (Read-Host -AsSecureString) 'senha.dat'

Write-Host "Token do portal (AGENTE_TOKEN):"
Gravar (Read-Host -AsSecureString) 'token.dat'
