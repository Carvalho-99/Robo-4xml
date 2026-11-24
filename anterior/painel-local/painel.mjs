// Painel do robô: uma página local onde o fiscal manda rodar agora e decide
// quando o robô roda sozinho.
//
// Sobe um servidor em 127.0.0.1 (só esta máquina alcança) e abre o navegador.
// Não guarda senha nem token do Protheus: isso continua cifrado pelo DPAPI.
//
// Quem entra aqui tem de ser admin do portal. A conferência é feita CONTRA o
// portal - a senha é repassada e nunca fica nesta máquina -, então as regras
// são as mesmas de lá, inclusive o bloqueio por tentativas repetidas.
//
//   node painel.mjs
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const PORTA = 8420;
const TAREFA = "Robo 4XML - NF-e 55 para o portal";
const AGENDA = join(AQUI, "agenda.json");
const MAX_HORARIOS = 2;
const SESSAO_HORAS = 8;
const config = JSON.parse(readFileSync(join(AQUI, "config.json"), "utf8"));
// Lida do proprio robo.mjs, para a tela nao poder discordar do que roda.
const VERSAO_ROBO = (/export const VERSAO = "([^"]+)"/.exec(readFileSync(join(AQUI, "robo.mjs"), "utf8")) || [])[1] || "?";
const PASTA_LOG = join(AQUI, "logs");
if (!existsSync(PASTA_LOG)) mkdirSync(PASTA_LOG, { recursive: true });

const PADRAO = {
  ligado: true,
  horarios: ["08:00", "17:00"],
  repeticao: "todo-dia",      // todo-dia | dias-uteis | datas
  datas: [],                  // ["2026-10-25", ...] quando repeticao = datas
  duracao: "sempre",          // sempre | dias
  dias: 5,                    // quando duracao = dias
};

const lerAgenda = () => {
  try { return { ...PADRAO, ...JSON.parse(readFileSync(AGENDA, "utf8")) }; }
  catch { return { ...PADRAO }; }
};

// ---------- quem está entrando ----------

const sessoes = new Map();   // token -> { usuario, expira }
const idasAoPortal = new Map();   // estado sorteado -> quando saiu daqui
const portal = () => (process.env.PORTAL_URL || config.portal).replace(/\/+$/, "");

function abrirSessao(usuario) {
  const token = randomBytes(32).toString("base64url");
  sessoes.set(token, { usuario, expira: Date.now() + SESSAO_HORAS * 3600e3 });
  return token;
}

function usuarioDe(req) {
  const cru = String(req.headers.cookie || "");
  const casa = /(?:^|;\s*)painel=([^;]+)/.exec(cru);
  if (!casa) return null;
  const s = sessoes.get(casa[1]);
  if (!s) return null;
  if (s.expira < Date.now()) { sessoes.delete(casa[1]); return null; }
  return s.usuario;
}

// Pergunta ao portal se o e-mail e a senha valem, e qual o perfil. A senha
// passa por aqui e segue adiante; nada dela fica gravado.
async function conferirNoPortal(email, senha) {
  const base = portal();
  let resp;
  try {
    resp = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, senha }),
    });
  } catch {
    return { erro: "Não consegui falar com o portal. Confira a conexão e tente de novo." };
  }
  const corpo = await resp.json().catch(() => ({}));
  if (!resp.ok) return { erro: corpo?.erro || "E-mail ou senha incorretos." };
  const usuario = corpo?.usuario;
  if (!usuario) return { erro: "O portal respondeu de um jeito que eu não entendi." };
  if (usuario.perfil !== "admin") {
    return { erro: "Este painel é só para administradores do portal." };
  }
  return { usuario };
}

// ---------- execução do robô ----------

let rodando = null;              // processo em andamento
let linhas = [];                 // o que ele imprimiu nesta execução
const ouvintes = new Set();      // navegadores acompanhando

function avisar(evento, dado) {
  const bloco = `event: ${evento}\ndata: ${JSON.stringify(dado)}\n\n`;
  for (const r of ouvintes) r.write(bloco);
}

function rodarRobo(modo) {
  if (rodando) return false;
  linhas = [];
  const argumentos = modo === "colher" ? ["robo.mjs", "--so-colher"] : ["robo.mjs"];
  rodando = spawn(process.execPath, argumentos, { cwd: AQUI });

  const receber = (dados) => {
    for (const linha of String(dados).split(/\r?\n/)) {
      if (!linha.trim()) continue;
      linhas.push(linha);
      avisar("linha", linha);
    }
  };
  rodando.stdout.on("data", receber);
  rodando.stderr.on("data", receber);
  rodando.on("close", (codigo) => {
    rodando = null;
    avisar("fim", { codigo, ok: codigo === 0 });
  });
  return true;
}

// ---------- agendamento ----------

// Monta o PowerShell que reescreve a tarefa do Windows. Cada opção da tela
// vira um tipo de gatilho: todo dia, dias úteis, ou datas escolhidas a dedo.
function scriptDaAgenda(agenda) {
  const linhasPs = [
    "$ErrorActionPreference = 'Stop'",
    `$tarefa = '${TAREFA}'`,
    "if (Get-ScheduledTask -TaskName $tarefa -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $tarefa -Confirm:$false }",
  ];

  if (!agenda.ligado || !agenda.horarios.length) {
    linhasPs.push("Write-Output 'automatico desligado'");
    return linhasPs.join("\n");
  }

  const gatilhos = [];
  for (const hora of agenda.horarios) {
    if (agenda.repeticao === "dias-uteis") {
      gatilhos.push(`New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At '${hora}'`);
    } else if (agenda.repeticao === "datas") {
      for (const dia of agenda.datas) gatilhos.push(`New-ScheduledTaskTrigger -Once -At (Get-Date '${dia} ${hora}')`);
    } else {
      gatilhos.push(`New-ScheduledTaskTrigger -Daily -At '${hora}'`);
    }
  }
  if (!gatilhos.length) {
    linhasPs.push("Write-Output 'sem gatilhos: nada agendado'");
    return linhasPs.join("\n");
  }

  linhasPs.push(`$gatilhos = @(${gatilhos.map((g) => `(${g})`).join(", ")})`);
  // "Pelos próximos N dias" é uma data de validade em cada gatilho; depois
  // dela a tarefa simplesmente para de disparar.
  if (agenda.duracao === "dias" && Number(agenda.dias) > 0) {
    linhasPs.push(`$fim = (Get-Date).AddDays(${Number(agenda.dias)}).ToString('yyyy-MM-ddTHH:mm:ss')`);
    linhasPs.push("foreach ($g in $gatilhos) { $g.EndBoundary = $fim }");
  }
  linhasPs.push(
    `$acao = New-ScheduledTaskAction -Execute '${process.execPath.replace(/'/g, "''")}' -Argument 'robo.mjs' -WorkingDirectory '${AQUI.replace(/'/g, "''")}'`,
    "$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew",
    "$quem = New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\\$env:USERNAME\" -LogonType Interactive",
    "Register-ScheduledTask -TaskName $tarefa -Action $acao -Trigger $gatilhos -Settings $config -Principal $quem -Description 'Sincroniza o Espiao XML do 4XML com a SEFAZ e manda as NF-e 55 ao portal.' | Out-Null",
    "Write-Output 'agendado'",
  );
  return linhasPs.join("\n");
}

const powershell = (script) => new Promise((resolve) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", maxBuffer: 4e6 },
    (erro, saida, erroSaida) => resolve({ ok: !erro, saida: String(saida || "").trim(), erro: String(erroSaida || erro?.message || "").trim() }));
});

// Consultar o agendador custa caro: subir um powershell.exe leva uns 4
// segundos. Se a tela inteira esperasse por isso, o painel levaria 5 segundos
// para mostrar qualquer coisa. Então o dado fica guardado por um tempo e é
// buscado por fora, numa rota só dele.
let tarefaGuardada = { valor: null, quando: 0, buscando: false };
const VALIDADE_TAREFA = 20000;

function tarefaEmCache() {
  if (Date.now() - tarefaGuardada.quando > VALIDADE_TAREFA && !tarefaGuardada.buscando) {
    tarefaGuardada.buscando = true;
    estadoDaTarefa()
      .then((valor) => { tarefaGuardada = { valor, quando: Date.now(), buscando: false }; })
      .catch(() => { tarefaGuardada.buscando = false; });
  }
  return tarefaGuardada;
}

// Quando a tarefa rodou pela última vez e quando roda de novo, direto do
// Windows - e não do que a tela acha que configurou.
async function estadoDaTarefa() {
  const r = await powershell(
    `$t = Get-ScheduledTask -TaskName '${TAREFA}' -ErrorAction SilentlyContinue; ` +
    "if (-not $t) { 'nenhuma' } else { $i = Get-ScheduledTaskInfo $t; " +
    "@{ estado = [string]$t.State; ultima = [string]$i.LastRunTime; resultado = $i.LastTaskResult; proxima = [string]$i.NextRunTime } | ConvertTo-Json -Compress }");
  if (!r.ok || r.saida === "nenhuma" || !r.saida) return null;
  try { return JSON.parse(r.saida); } catch { return null; }
}

function diarioDeHoje() {
  const dia = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const arquivo = join(PASTA_LOG, `${dia}.log`);
  if (!existsSync(arquivo)) return [];
  return readFileSync(arquivo, "utf8").split(/\r?\n/).filter(Boolean).slice(-200);
}

// Quantas notas a última execução entregou, lido do proprio diario.
function ultimoResultado() {
  for (const linha of [...diarioDeHoje()].reverse()) {
    const casa = /portal:\s*(\{.*\})/.exec(linha);
    if (!casa) continue;
    try { return { ...JSON.parse(casa[1]), quando: linha.slice(0, 19) }; } catch { return null; }
  }
  return null;
}

// ---------- servidor ----------

const json = (res, dado, status = 200, cabecalhos = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...cabecalhos });
  res.end(JSON.stringify(dado));
};

const pagina = (res, arquivo) => {
  // Sem isto o navegador guarda a pagina e continua mostrando a versao
  // antiga depois de uma atualizacao do painel - o que ja aconteceu.
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, must-revalidate",
  });
  res.end(readFileSync(join(AQUI, arquivo)));
};

// Arquivos do Three.js e o modelo do robo. So estas duas pastas, e o caminho
// e limpo antes de virar caminho de verdade: sem isso, um pedido com ".."
// leria qualquer arquivo da maquina.
const TIPOS = { ".js": "text/javascript", ".glb": "model/gltf-binary", ".png": "image/png", ".jpg": "image/jpeg" };

function servirArquivo(res, pedido) {
  const limpo = pedido.split("/").filter((p) => p && p !== "." && p !== "..");
  // robo-cena.js fica na raiz da pasta: e o unico arquivo solto que sai daqui.
  if (limpo.length === 1 && limpo[0] === "robo-cena.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    res.end(readFileSync(join(AQUI, "robo-cena.js")));
    return true;
  }
  if (!limpo.length || !["vendor", "modelo"].includes(limpo[0])) return false;
  const caminho = join(AQUI, ...limpo);
  if (!existsSync(caminho)) return false;
  const ponto = caminho.lastIndexOf(".");
  res.writeHead(200, {
    "content-type": TIPOS[caminho.slice(ponto).toLowerCase()] || "application/octet-stream",
    "cache-control": "public, max-age=86400",
  });
  res.end(readFileSync(caminho));
  return true;
}

const corpoDe = (req) => new Promise((resolve) => {
  let texto = "";
  req.on("data", (p) => { texto += p; if (texto.length > 1e6) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(texto)); } catch { resolve(null); } });
});

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const usuario = usuarioDe(req);

  // --- porta de entrada ---
  if (url.pathname === "/api/entrar" && req.method === "POST") {
    const corpo = await corpoDe(req);
    const email = String(corpo?.email || "").trim().toLowerCase();
    const senha = String(corpo?.senha || "");
    if (!email || !senha) { json(res, { erro: "Informe e-mail e senha." }, 400); return; }
    const r = await conferirNoPortal(email, senha);
    if (r.erro) { json(res, { erro: r.erro }, 401); return; }
    const token = abrirSessao(r.usuario);
    json(res, { usuario: r.usuario }, 200, {
      "set-cookie": `painel=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_HORAS * 3600}`,
    });
    return;
  }

  // Caminho pela conta Forest: o painel nao alcanca o Entra (roda em
  // 127.0.0.1, endereco que nao esta registrado no Azure). Entao manda a
  // pessoa ao portal, que autentica e devolve um codigo de uso unico.
  if (url.pathname === "/ir-ao-portal") {
    const estado = randomBytes(24).toString("base64url");
    idasAoPortal.set(estado, Date.now());
    for (const [e, quando] of idasAoPortal) if (Date.now() - quando > 10 * 60e3) idasAoPortal.delete(e);
    res.writeHead(302, { location: `${portal()}/api/painel/entrar?estado=${estado}&porta=${PORTA}` });
    res.end();
    return;
  }

  if (url.pathname === "/entrar") {
    const codigo = String(url.searchParams.get("codigo") || "");
    const estado = String(url.searchParams.get("estado") || "");
    // So aceita a volta de uma ida que saiu daqui: sem isso, qualquer pagina
    // poderia empurrar um codigo para este endereco.
    if (!idasAoPortal.delete(estado)) { pagina(res, "entrar.html"); return; }
    let r;
    try {
      const resp = await fetch(`${portal()}/api/painel/trocar`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ codigo }),
      });
      r = await resp.json().catch(() => ({}));
      if (!resp.ok) r = { erro: r?.erro || "O portal recusou o código." };
    } catch {
      r = { erro: "Não consegui falar com o portal." };
    }
    if (r.erro || r.estado !== estado) {
      res.writeHead(302, { location: "/?erro=" + encodeURIComponent(r.erro || "A volta do portal não confere.") });
      res.end();
      return;
    }
    const token = abrirSessao(r.usuario);
    res.writeHead(302, {
      location: "/",
      "set-cookie": `painel=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSAO_HORAS * 3600}`,
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/sair" && req.method === "POST") {
    const casa = /(?:^|;\s*)painel=([^;]+)/.exec(String(req.headers.cookie || ""));
    if (casa) sessoes.delete(casa[1]);
    json(res, { ok: true }, 200, { "set-cookie": "painel=; HttpOnly; Path=/; Max-Age=0" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    pagina(res, usuario ? "painel.html" : "entrar.html");
    return;
  }

  // O robo da tela de entrada aparece antes de qualquer sessao: estes
  // arquivos ficam fora da porteira, de proposito.
  if (servirArquivo(res, url.pathname)) return;

  // Pagina de calibracao dos eixos do modelo (so existe em desenvolvimento).
  if (url.pathname === "/calibrar.html" && existsSync(join(AQUI, "calibrar.html"))) {
    pagina(res, "calibrar.html");
    return;
  }

  // --- daqui para baixo, só com sessão ---
  if (!usuario) { json(res, { erro: "Entre para continuar." }, 401); return; }

  if (url.pathname === "/api/estado") {
    json(res, {
      usuario,
      rodando: Boolean(rodando),
      linhas,
      agenda: lerAgenda(),
      diario: diarioDeHoje(),
      ultimo: ultimoResultado(),
      filial: config.filiais?.[0]?.codigo || "",
      versao: VERSAO_ROBO,
    });
    return;
  }

  // Rota separada justamente porque e lenta: a tela ja apareceu antes dela.
  if (url.pathname === "/api/tarefa") {
    const guardada = tarefaEmCache();
    json(res, { tarefa: guardada.valor, conhecida: guardada.quando > 0 });
    return;
  }

  if (url.pathname === "/api/acompanhar") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("\n");
    ouvintes.add(res);
    req.on("close", () => ouvintes.delete(res));
    return;
  }

  if (url.pathname === "/api/rodar" && req.method === "POST") {
    const corpo = await corpoDe(req);
    const comecou = rodarRobo(corpo?.modo === "colher" ? "colher" : "completo");
    json(res, comecou ? { ok: true } : { erro: "O robô já está rodando." }, comecou ? 200 : 409);
    return;
  }

  if (url.pathname === "/api/parar" && req.method === "POST") {
    if (rodando) {
      rodando.kill();
      const dia = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
      appendFileSync(join(PASTA_LOG, `${dia}.log`),
        `${new Date().toLocaleString("pt-BR")}  interrompido por ${usuario.email}\n`);
    }
    json(res, { ok: true });
    return;
  }

  if (url.pathname === "/api/agenda" && req.method === "POST") {
    const corpo = await corpoDe(req);
    if (!corpo) { json(res, { erro: "Não entendi o que foi enviado." }, 400); return; }
    const agenda = {
      ligado: Boolean(corpo.ligado),
      // No máximo duas vezes por dia: cada ciclo completo leva uns 20 minutos
      // de Protheus, e mais que isso só atrapalharia quem está trabalhando.
      horarios: (Array.isArray(corpo.horarios) ? corpo.horarios : [])
        .filter((h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h)).slice(0, MAX_HORARIOS),
      repeticao: ["todo-dia", "dias-uteis", "datas"].includes(corpo.repeticao) ? corpo.repeticao : "todo-dia",
      datas: (Array.isArray(corpo.datas) ? corpo.datas : [])
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 60),
      duracao: corpo.duracao === "dias" ? "dias" : "sempre",
      dias: Math.min(365, Math.max(1, Number(corpo.dias) || 5)),
    };
    writeFileSync(AGENDA, JSON.stringify(agenda, null, 2));
    const r = await powershell(scriptDaAgenda(agenda));
    tarefaGuardada = { valor: await estadoDaTarefa(), quando: Date.now(), buscando: false };
    json(res, r.ok ? { agenda, saida: r.saida } : { erro: r.erro || "O Windows recusou o agendamento." }, r.ok ? 200 : 500);
    return;
  }

  res.writeHead(404); res.end("não achei");
});

servidor.listen(PORTA, "127.0.0.1", () => {
  const endereco = `http://127.0.0.1:${PORTA}/`;
  console.log(`Painel do robô em ${endereco}`);
  console.log("Feche esta janela para encerrar o painel.");
  execFile("cmd", ["/c", "start", "", endereco], () => {});
});
