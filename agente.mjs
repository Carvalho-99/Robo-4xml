// O agente: a parte do robô que mora na máquina e fica à disposição do
// portal.
//
// Ele não decide nada. De 20 em 20 segundos pergunta ao portal "tem serviço
// para mim?"; quando tem, roda o robo.mjs e devolve o diário linha a linha,
// para quem estiver olhando a aba Robô ver acontecendo. Como é sempre ele
// quem liga para o portal, nada precisa ser aberto no firewall da Forest.
//
// Roda escondido, começa junto com o Windows e, se morrer, a tarefa agendada
// o traz de volta em até dez minutos. Ninguém o vê - é essa a intenção.
//
//   node agente.mjs            fica no ar, obedecendo o portal
//   node agente.mjs --uma-vez  pergunta uma vez e sai (para conferir a instalação)
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { segredo } from "./segredos.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
// O agente tambem roda em servidor Linux, sob o pm2 (provado em 29/10/2026
// no server-reembolso). O robo em si nao precisou de uma linha: basta o
// caminho do navegador no config.json e a senha em variavel de ambiente. O
// agente precisa, porque descompactar e se reiniciar sao as duas coisas que
// ele faz pelo sistema operacional.
const NO_WINDOWS = process.platform === "win32";
const UMA_VEZ = process.argv.includes("--uma-vez");

const PASTA_LOG = join(AQUI, "logs");
if (!existsSync(PASTA_LOG)) mkdirSync(PASTA_LOG, { recursive: true });

// De quanto em quanto tempo o agente pergunta ao portal. A variável de
// ambiente existe só para os testes, que não podem esperar 20 segundos
// reais para ver uma batida acontecer.
const SEGUNDOS_ENTRE_PERGUNTAS = Number(process.env.ROBO_SEGUNDOS_PING) || 20;
// Com o robô trabalhando, o portal fica em silêncio se ninguém mandar nada.
// Três segundos é curto para a tela parecer ao vivo e longo para não fazer
// uma chamada por linha impressa.
const MS_ENTRE_ENVIOS_DE_LOG = 3000;

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

function diga(...partes) {
  const linha = `${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}  ${partes.join(" ")}`;
  console.log(linha);
  const dia = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  appendFileSync(join(PASTA_LOG, `agente-${dia}.log`), linha + "\n");
}

// ---------- um agente por maquina ----------

// A tarefa agendada repete de 10 em 10 minutos para o caso de o agente
// morrer. Mas quem ela executa é o wscript, que sai no mesmo instante em que
// larga o node: do ponto de vista do Windows a tarefa termina sempre, e o
// "MultipleInstances IgnoreNew" nunca entra em ação. Sem a trava abaixo, uma
// máquina ligada o dia inteiro acumularia um agente a cada dez minutos, e
// todos eles pegando serviço do portal.
//
// A trava é uma porta local: quem conseguir abrir é o agente desta máquina.
// Porta não deixa resto para trás - se o processo morre, ela se solta
// sozinha, coisa que um arquivo de bloqueio com PID não garante.
// A porta é fixa de propósito: é ela que define "um agente por máquina".
// A variável de ambiente existe só para os testes, que precisam de um
// agente de mentira sem brigar com o agente de verdade desta máquina.
const PORTA_DA_TRAVA = Number(process.env.ROBO_PORTA_TRAVA) || 8421;

function travar() {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(null));
    s.listen(PORTA_DA_TRAVA, "127.0.0.1", () => {
      s.unref();
      resolve(s);
    });
  });
}

// ---------- identidade ----------

const identidade = JSON.parse(readFileSync(join(AQUI, "maquina.json"), "utf8"));
const PORTAL = String(identidade.portal || "").replace(/\/+$/, "");
const TOKEN = segredo(AQUI, "token.dat", "PORTAL_TOKEN");

// A versão vem do próprio robô, lida do arquivo: uma só verdade, e é ela que
// o portal compara para saber se esta máquina está atrasada.
function versaoDoRobo() {
  try {
    const fonte = readFileSync(join(AQUI, "robo.mjs"), "utf8");
    return fonte.match(/export const VERSAO = "([^"]+)"/)?.[1] || "";
  } catch {
    return "";
  }
}

async function aoPortal(rota, corpo) {
  const r = await fetch(`${PORTAL}${rota}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error(`portal respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- execução ----------

// Nenhum ciclo de verdade passa disso - a sincronizacao sozinha pode levar
// uns 17 minutos por filial, e ler os valores mais um tanto. 45 minutos e
// folga generosa, e ainda bem menor que os 90 que o PORTAL espera antes de
// desistir sozinho (encerrarAbandonadas, em src/robo/api.js): o agente tem
// de perceber e se destravar primeiro, sem esperar o portal notar.
//
// Fracionario para os testes poderem passar um numero pequeno sem criar uma
// variavel nova so para isso.
const MINUTOS_MAX_CICLO = Number(process.env.ROBO_MINUTOS_MAX_CICLO) || 45;

// Roda o robô e vai mandando o que ele imprime. O diário é a única janela
// que a pessoa tem para dentro desta máquina, então nada é engolido: o que
// sai na saída de erro vai junto com o resto, na ordem em que aconteceu.
function rodarRobo(comando, pedirParada) {
  return new Promise((resolve) => {
    const argumentos = ["robo.mjs"];
    if (comando.tipo === "colher") argumentos.push("--so-colher");

    // O período escolhido no "Puxar notas" viaja como ambiente: o robô troca a
    // janela padrão por ele. Em branco, nada é passado e o padrão vale.
    const ambiente = { ...process.env };
    if (comando.de) ambiente.COLHER_DE = comando.de;
    if (comando.ate) ambiente.COLHER_ATE = comando.ate;

    const filho = spawn(process.execPath, argumentos, { cwd: AQUI, windowsHide: true, env: ambiente });
    // "parando" decide se ja existe um pedido de parada em andamento -
    // idempotente, porque o portal pode cancelar E a trava de tempo pode
    // estourar quase junto. "motivo" e so para o relato, nao muda o kill.
    let parando = false;
    let motivo = "";
    const pararFilho = (qual, linha) => {
      if (parando) return;
      parando = true;
      motivo = qual;
      fila.push(linha);
      filho.kill();
      // Se o robô não sair sozinho, o navegador dele pode segurar o
      // processo: insiste uma vez.
      setTimeout(() => { if (filho.exitCode === null) filho.kill("SIGKILL"); }, 4000);
    };
    // Quem manda parar é o portal, pela batida de sinal de vida.  Encerrar o
    // robô aqui é seguro: a carga das notas é a ÚLTIMA coisa do ciclo, então
    // um ciclo interrompido não envia nada para o portal.
    pedirParada(() => pararFilho("cancelado", "--- cancelado pelo portal; encerrando sem enviar nada ---"));
    // Trava de tempo: nada no robo.mjs percebe sozinho quando uma espera sua
    // trava para sempre - foi o que aconteceu em 10/11/2026, quando o ciclo
    // parou no meio da leitura de uma nota e o agente continuou batendo
    // "ocupado" no portal por mais de 24 horas, sem jeito de liberar a fila
    // daquela maquina sem alguem desligar o processo na mao.
    //
    // Em vez de confiar que o robo.mjs vai perceber e sair sozinho, o agente
    // poe um prazo por fora e mata o processo filho pelo MESMO caminho do
    // cancelamento pelo portal - inclusive a insistencia com SIGKILL, para o
    // caso de o travamento ter puxado o navegador dele junto. A proxima
    // pergunta ao portal (ou "Executar agora") comeca um robo.mjs novo, do
    // zero: nao ha estado para destravar, so processo para matar.
    const relogioTravado = setTimeout(() => {
      diga(`  ciclo nao terminou em ${MINUTOS_MAX_CICLO} minuto(s); encerrando o robo sozinho`);
      pararFilho("travado", `--- o agente encerrou o robo sozinho: nao respondeu em ${MINUTOS_MAX_CICLO} minuto(s) ---`);
    }, MINUTOS_MAX_CICLO * 60000);
    let fila = [];
    let ultimaLinha = "";
    let sobra = { out: "", err: "" };

    const engolir = (qual) => (pedaco) => {
      const texto = sobra[qual] + pedaco.toString();
      const partes = texto.split(/\r?\n/);
      sobra[qual] = partes.pop();
      for (const l of partes) if (l.trim()) { fila.push(l); ultimaLinha = l; }
    };
    filho.stdout.on("data", engolir("out"));
    filho.stderr.on("data", engolir("err"));

    // Teto da fila: com o portal fora do ar por horas, guardar tudo acabaria
    // com a memória. Perder as linhas MAIS VELHAS é melhor do que perder as
    // recentes, que são as que dizem onde o robô está agora.
    const MAX_NA_FILA = 2000;
    let avisouDaRede = false;

    const enviar = async () => {
      if (!fila.length) return;
      const lote = fila.splice(0, 200);
      try {
        await aoPortal("/api/robo/log", { comandoId: comando.id, linhas: lote });
        avisouDaRede = false;
      } catch (err) {
        // A rede caiu. As linhas voltam para o começo da fila e vão na
        // próxima tentativa - antes elas eram descartadas aqui, e o diário
        // do portal ficava com um buraco bem no momento que interessa.
        fila.unshift(...lote);
        if (fila.length > MAX_NA_FILA) fila.splice(0, fila.length - MAX_NA_FILA);
        // Um aviso por queda, não um a cada três segundos: em 26/10/2026
        // isso encheu o diário local com 30 linhas iguais.
        if (!avisouDaRede) {
          diga("  sem contato com o portal; guardando o diario ate voltar:",
            String(err.message || err).slice(0, 80));
          avisouDaRede = true;
        }
      }
    };
    const relogio = setInterval(enviar, MS_ENTRE_ENVIOS_DE_LOG);

    filho.on("close", async (codigo) => {
      clearTimeout(relogioTravado);
      clearInterval(relogio);
      for (const qual of ["out", "err"]) if (sobra[qual].trim()) fila.push(sobra[qual]);
      await enviar();
      if (motivo === "travado") {
        resolve({ ok: false, resumo: `o ciclo nao respondeu em ${MINUTOS_MAX_CICLO} minuto(s); o agente encerrou sozinho e comeca do zero na proxima` });
        return;
      }
      if (motivo === "cancelado") { resolve({ ok: false, cancelado: true, resumo: "cancelado pelo portal" }); return; }
      resolve({ ok: codigo === 0, resumo: codigo === 0 ? ultimaLinha : `terminou com erro: ${ultimaLinha}` });
    });
    filho.on("error", async (err) => {
      clearTimeout(relogioTravado);
      clearInterval(relogio);
      fila.push(`nao consegui iniciar o robo: ${err.message}`);
      await enviar();
      resolve({ ok: false, resumo: `nao consegui iniciar o robo: ${err.message}` });
    });
  });
}

// ---------- atualização ----------

// Baixa o pacote novo e sai. Quem o traz de volta é a tarefa agendada, em
// até dez minutos, já rodando a versão nova.
//
// Isto existe por uma falha real: uma máquina passou dias com um robô velho,
// esperando uma sincronização que aquela versão nem sabia disparar, e
// ninguém tinha como perceber de longe.
async function atualizar(versaoEsperada) {
  diga(`versao nova no portal (${versaoEsperada}); baixando`);
  const r = await fetch(`${PORTAL}/api/robo/pacote.zip`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`pacote respondeu ${r.status}`);
  const zip = join(process.env.TEMP || tmpdir(), "robo-4xml-novo.zip");
  writeFileSync(zip, Buffer.from(await r.arrayBuffer()));

  // O config.json vem DENTRO do pacote, e isso e proposital: e assim que um
  // ajuste de periodo ou de limite de espera chega sozinho a todas as
  // maquinas. Mas tres chaves sao desta maquina, e nao do pacote: onde fica
  // o navegador, com que usuario entra e qual portal obedece.
  //
  // Sem preservar, o servidor Linux perderia o caminho do Chromium na
  // primeira atualizacao e so falharia na execucao seguinte - longe da
  // causa. No Windows o estrago passava despercebido porque os valores do
  // repositorio por acaso batem com os da maquina.
  const MEUS = ["navegador", "usuario", "portal"];
  const guardado = {};
  try {
    const atual = JSON.parse(readFileSync(join(AQUI, "config.json"), "utf8"));
    for (const chave of MEUS) if (atual[chave]) guardado[chave] = atual[chave];
  } catch { /* primeira instalacao: nao ha config para preservar */ }

  // O finally existe porque a extracao pode falhar DEPOIS de ja ter
  // sobrescrito o config.json - e foi o que aconteceu no servidor em
  // 30/10/2026: o robo perdeu o caminho do navegador e so quebrou na
  // execucao seguinte. Devolver o que e da maquina vale mesmo quando o
  // resto deu errado.
  try {
    await descompactar(zip, AQUI);
  } finally {
    try {
      const novo = JSON.parse(readFileSync(join(AQUI, "config.json"), "utf8"));
      writeFileSync(join(AQUI, "config.json"), JSON.stringify({ ...novo, ...guardado }, null, 2));
    } catch (err) {
      diga(`ATENCAO: nao consegui preservar o config.json: ${err.message}`);
    }
  }
  // No Linux o pm2 e a tarefa agendada: ele ve o processo sair e sobe o
  // novo na hora. Nao ha console piscando nem trava de porta para esperar.
  if (!NO_WINDOWS) {
    diga("atualizado; o pm2 traz a versao nova");
    process.exit(0);
  }

  // Voltar JA, em vez de esperar a tarefa agendada.
  //
  // A tarefa repete de 10 em 10 minutos, entao sair e esperar deixava a
  // maquina ate 10 minutos fora do ar a cada atualizacao - com os botoes do
  // portal desligados e a pessoa achando que quebrou. Em 26/10/2026, com
  // quatro versoes publicadas seguidas, isso comeu boa parte da tarde.
  //
  // Os 8 segundos de folga sao para este processo morrer e soltar a trava da
  // porta antes de o novo tentar pega-la; sem isso o novo desistiria em
  // silencio, achando que ja existe um agente de pe.
  // Pelo wscript, e nao pelo cmd.
  //
  // Com `detached: true` o Windows da um console PROPRIO ao processo filho e
  // o windowsHide deixa de valer - uma janela preta "timeout /t 8" ficava
  // piscando na cara de quem usa o computador a cada atualizacao. O wscript
  // nao tem console: ele e o mesmo mecanismo que ja roda o agente sem
  // janela.
  const voltar = join(AQUI, "voltar.vbs");
  writeFileSync(voltar, [
    "WScript.Sleep 8000",
    'CreateObject("WScript.Shell").Run "schtasks /run /tn ""Robo 4XML""", 0, False',
  ].join(String.fromCharCode(13, 10)));
  diga("atualizado; voltando na versao nova");
  spawn("wscript.exe", ["//B", "//Nologo", voltar], {
    detached: true, stdio: "ignore", windowsHide: true,
  }).unref();
  process.exit(0);
}

// Windows nao tem unzip e Linux nao tem PowerShell: cada um com a sua
// ferramenta, mesma promessa.
function descompactar(zip, destino) {
  const [programa, argumentos] = NO_WINDOWS
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destino}' -Force`]]
    : ["unzip", ["-o", "-q", zip, "-d", destino]];
  return new Promise((resolve, reject) => {
    // windowsHide explicito mesmo aqui: no Linux nao custa nada, e e o que
    // o teste consegue enxergar lendo o codigo. Passar as opcoes por
    // variavel escondia a garantia de que nenhuma janela preta pisca na
    // cara de quem esta usando o computador.
    const p = spawn(programa, argumentos, { windowsHide: true });
    // O unzip devolve 1 para AVISO, e 2 ou mais para erro de verdade. O
    // pacote e montado no Windows pelo Compress-Archive, que grava barra
    // invertida como separador - e o unzip avisa sobre isso em toda
    // extracao, extraindo tudo certo do mesmo jeito. Tratar o 1 como falha
    // fazia a atualizacao "falhar" sempre no Linux, DEPOIS de ja ter
    // sobrescrito os arquivos. Visto em 30/10/2026 no servidor.
    const tolerado = programa === "unzip" ? 1 : 0;
    p.on("close", (c) => (c <= tolerado ? resolve() : reject(new Error(`${programa} saiu com ${c}`))));
    p.on("error", reject);
  });
}

// ---------- laço ----------

let ocupado = false;

// O aviso de fim NÃO PODE se perder.
//
// Em 26/10/2026 a rede da máquina caiu bem na hora de avisar, o aviso foi
// embora com um catch vazio, e o portal ficou achando que a execução
// continuava - sem como cancelar, sem como executar de novo. Agora o recado
// fica guardado e é reenviado a cada pergunta, até o portal aceitar.
let recadoPendente = null;

async function concluir(recado) {
  recadoPendente = recado;
  await tentarConcluir();
}

async function tentarConcluir() {
  if (!recadoPendente) return;
  try {
    await aoPortal("/api/robo/concluir", recadoPendente);
    recadoPendente = null;
  } catch (err) {
    diga("  nao consegui avisar o fim; vou insistir:", String(err.message || err).slice(0, 80));
  }
}

function pingar() {
  return aoPortal("/api/robo/ping", {
    maquinaId: identidade.id,
    nome: identidade.nome,
    usuarioWindows: identidade.usuarioWindows,
    instaladoPor: identidade.instaladoPor || "",
    // Servidor nao tem dono. A marcacao vem do arquivo de identidade porque
    // so quem instalou sabe se aquilo e o PC de alguem ou uma maquina que
    // fica ligada num canto.
    compartilhada: Boolean(identidade.compartilhada),
    versao: versaoDoRobo(),
    ocupado,
  });
}

async function umaVolta() {
  // Antes de qualquer coisa: se ficou um fim por avisar, avisa.
  await tentarConcluir();
  const resposta = await pingar();

  const esperada = String(resposta.versaoEsperada || "");
  if (!ocupado && esperada && esperada !== versaoDoRobo()) {
    await atualizar(esperada);
    return;
  }

  const comando = resposta.comando;
  if (!comando) return;

  ocupado = true;
  diga(`servico ${comando.id} (${comando.tipo}) pedido por ${comando.pedidoPor || comando.origem}`);
  // Um ciclo leva uns 20 minutos, e nesse tempo o laço de cima fica parado
  // esperando o robô. Sem esta batida, a máquina passa o serviço inteiro sem
  // dar sinal de vida e o portal a mostra como "sem contato" - justamente
  // quando ela está mais ocupada. O ping vai com ocupado=true, então não
  // traz serviço novo.
  // A batida também é por onde chega a ordem de parar: o portal não alcança
  // esta máquina, é ela que pergunta.
  let pararAgora = null;
  const batida = setInterval(() => {
    pingar().then((r) => {
      if (r?.cancelar?.comandoId === comando.id && pararAgora) {
        diga(`servico ${comando.id} cancelado por ${r.cancelar.por || "alguem no portal"}`);
        pararAgora();
      }
    }).catch(() => {});
  }, SEGUNDOS_ENTRE_PERGUNTAS * 1000);
  try {
    const r = await rodarRobo(comando, (parar) => { pararAgora = parar; });
    await concluir({
      comandoId: comando.id, ok: r.ok, cancelado: Boolean(r.cancelado), resumo: r.resumo,
    });
    diga(`servico ${comando.id} ${r.cancelado ? "cancelado" : r.ok ? "concluido" : "falhou"}`);
  } catch (err) {
    diga(`servico ${comando.id} quebrou:`, String(err.message || err));
    await concluir({
      comandoId: comando.id, ok: false, resumo: String(err.message || err).slice(0, 300),
    });
  } finally {
    clearInterval(batida);
    ocupado = false;
  }
}

if (!UMA_VEZ && !(await travar())) {
  // Nada de erro: é o caso normal da repetição da tarefa agendada
  // encontrando o agente já de pé.
  process.exit(0);
}

diga(`agente no ar (maquina ${identidade.nome}, robo ${versaoDoRobo() || "?"}) falando com ${PORTAL}`);

let seguidasComErro = 0;
for (;;) {
  try {
    await umaVolta();
    seguidasComErro = 0;
  } catch (err) {
    seguidasComErro += 1;
    // Um aviso por queda, e depois silêncio: sem isto, um portal fora do ar
    // durante a noite enche o disco de linhas iguais.
    if (seguidasComErro <= 3 || seguidasComErro % 60 === 0) {
      diga("sem contato com o portal:", String(err.message || err).slice(0, 160));
    }
  }
  if (UMA_VEZ) break;
  // Depois de uma queda, pergunta mais devagar - até um minuto.
  await pausa(SEGUNDOS_ENTRE_PERGUNTAS * 1000 * Math.min(3, Math.max(1, seguidasComErro)));
}
