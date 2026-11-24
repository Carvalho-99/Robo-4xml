// Senha do Protheus e token do portal, cifrados pelo DPAPI do Windows.
//
// O arquivo está atado à conta que instalou: não serve em outra máquina nem
// para outro usuário. Quem escreve é o instalador; quem lê são o robô e o
// agente.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function segredo(pasta, arquivo, variavel) {
  // A variável de ambiente passa na frente: é assim que se testa sem mexer
  // no que está guardado na máquina.
  if (process.env[variavel]) return process.env[variavel];
  const caminho = join(pasta, arquivo);
  if (!existsSync(caminho)) {
    throw new Error(`Falta ${arquivo}. Baixe o instalador do robô no portal e rode de novo.`);
  }
  // O Set-Content do PowerShell 5.1 grava BOM no começo e quebra de linha no
  // fim; o ConvertTo-SecureString recusa os dois, e a senha, gravada certa,
  // fica ilegível. O Trim resolve, e tolera arquivos antigos já com BOM.
  const comando = `$t = [IO.File]::ReadAllText('${caminho}').Trim(); `
    + "$s = ConvertTo-SecureString $t; "
    + "[Runtime.InteropServices.Marshal]::PtrToStringAuto("
    + "[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";
  // windowsHide: sem isto uma janela preta do PowerShell PISCA na cara de
  // quem esta usando o computador, duas vezes por execucao (senha e token).
  // O robo trabalha em segundo plano; aparecer e defeito.
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", comando],
    { encoding: "utf8", windowsHide: true }).trim();
}
