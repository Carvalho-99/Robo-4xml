// Robo do 4XML: faz no Protheus, sozinho, o que o fiscal fazia a mao duas
// vezes por dia - sincronizar o Espiao XML com a SEFAZ e trazer a lista de
// NF-e 55 que os fornecedores emitiram contra os CNPJs da Forest.
//
// Mora na maquina do fiscal porque o 4XML so existe dentro do Protheus: nao
// ha API, e as tabelas do 4XML nao estao no dicionario (conferido em
// 22/10/2026 - SX2/SX3 nao conhecem nem a coluna "Dt. Conf. Portaria"), entao
// o GenericQuery do portal nao alcanca esses dados.
//
// O robo nao baixa arquivo nenhum: ele le a grade direto da memoria da tela.
// Por isso nao depende do TOTVS WebAgent, que e justamente o que faz o
// "Exp. Excel" falhar quando o agente local nao esta instalado.
//
//   node robo.mjs                 ciclo inteiro (sincroniza e colhe)
//   node robo.mjs --so-colher     so le a grade e manda ao portal
//   COLHER_DE/COLHER_ATE          periodo (ISO) do "Puxar notas"; vazio = padrao
//   node robo.mjs --reler-valores le de novo o valor de TODAS as notas
//   node robo.mjs --so-sincronizar
//   node robo.mjs --visivel       mostra a janela (para acompanhar)
//   node robo.mjs --seco          nao manda nada ao portal, so mostra
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { segredo as lerSegredo } from "./segredos.mjs";
import { resolverPeriodo } from "./periodo.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(AQUI, "config.json"), "utf8"));
// O usuario vem do config.json, mas uma variavel de ambiente passa na frente:
// e assim que se testa uma conta nova sem reescrever o arquivo da maquina.
const USUARIO = process.env.PROTHEUS_USUARIO || config.usuario;
// Sobe junto com QUALQUER mudanca de comportamento, inclusive duas no mesmo
// dia - dai o sufixo. O portal compara esta string com a do pacote publicado
// e e assim que uma maquina atrasada se atualiza sozinha; se a versao nao
// mudar, a atualizacao nao acontece. Foi o que custou um dia inteiro de
// sincronizacao sem efeito em 23/10/2026.
export const VERSAO = "2026.11.11.2";

const opcoes = new Set(process.argv.slice(2));
const SECO = opcoes.has("--seco");
const VISIVEL = opcoes.has("--visivel") || config.janela === "visivel";

// ---------- diario ----------

const PASTA_LOG = join(AQUI, "logs");
if (!existsSync(PASTA_LOG)) mkdirSync(PASTA_LOG, { recursive: true });

function agora() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function diga(...partes) {
  const linha = `${agora()}  ${partes.join(" ")}`;
  console.log(linha);
  const dia = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  appendFileSync(join(PASTA_LOG, `${dia}.log`), linha + "\n");
}

// ---------- segredos ----------

// Senha e token moram cifrados ao lado do robo; ver segredos.mjs.
const segredo = (arquivo, variavel) => lerSegredo(AQUI, arquivo, variavel);

// ---------- navegador ----------

const NAVEGADORES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

function acharNavegador() {
  if (config.navegador && existsSync(config.navegador)) return config.navegador;
  const achado = NAVEGADORES.find((c) => existsSync(c));
  if (!achado) throw new Error("Nao achei Edge nem Chrome; informe o caminho em config.json > navegador");
  return achado;
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- a tela do Protheus ----------
//
// Tudo e componente wa-* com shadow root aberto, entao o Playwright enxerga
// por papel (getByRole) e por atributo caption. Texto solto nao casa.

const botao = (page, caption) => page.locator(`wa-button[caption="${caption}"]`).first();

async function clicarCaption(page, caption, espera = 6000) {
  const alvo = botao(page, caption);
  await alvo.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  await alvo.click({ timeout: 20000 });
  await pausa(espera);
}

// Textos que estao de fato na tela. A pagina guarda rotulos escondidos da
// abertura ("Aguarde para utilizar o TOTVS...", "Carregando"): sem filtrar
// por visibilidade, o robo acha que esta sempre ocupado.
function textosVisiveis(page) {
  return page.evaluate(() => {
    const t = [];
    const visitar = (raiz) => {
      for (const el of raiz.querySelectorAll("wa-text-view")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) t.push(el.getAttribute("caption") || "");
      }
      for (const el of raiz.querySelectorAll("*")) if (el.shadowRoot) visitar(el.shadowRoot);
    };
    visitar(document);
    // O splash da abertura nunca sai da pagina: fica coberto, com tamanho,
    // dizendo "Aguarde para utilizar..." para sempre. Se contar como
    // trabalho em andamento, o robo espera a toa ate estourar o limite.
    const SPLASH = /aguarde para utilizar|^carregando$|dicion.rio de par/i;
    return t.filter((x) => !SPLASH.test(String(x).replace(/<[^>]*>/g, "").trim()));
  }).catch(() => []);
}

// Campo de um dialogo do Protheus: acha o rotulo e pega o campo da mesma
// linha. Mais estavel que o id COMPxxxx, que muda a cada abertura da tela.
async function campoDoRotulo(page, rotulo) {
  const mao = await page.evaluateHandle((rot) => {
    const caixas = [];
    const visitar = (raiz) => {
      for (const el of raiz.querySelectorAll("*")) {
        caixas.push(el);
        if (el.shadowRoot) visitar(el.shadowRoot);
      }
    };
    visitar(document);
    const limpa = (t) => String(t || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const alvo = rot.toLowerCase();
    const rotulos = caixas.filter((el) => el.tagName.toLowerCase() === "wa-text-view"
      && limpa(el.getAttribute("caption")).startsWith(alvo));
    if (!rotulos.length) return null;
    // O rotulo fica ao LADO do campo no dialogo de parametros e ACIMA dele na
    // barra da grade ("NF-e Nro."). Aceita os dois e fica com o mais proximo.
    const r = rotulos[0].getBoundingClientRect();
    const meio = r.y + r.height / 2;
    const campos = caixas
      .filter((el) => /^(input|select)$/.test(el.tagName.toLowerCase()))
      .map((el) => ({ el, c: el.getBoundingClientRect() }))
      .filter(({ c }) => c.width > 0 && c.height > 0)
      .filter(({ c }) => {
        const aoLado = c.y < meio && c.y + c.height > meio && c.x > r.x && c.x - r.right < 260;
        const abaixo = c.y >= r.bottom - 4 && c.y - r.bottom < 40 && Math.abs(c.x - r.x) < 160;
        return aoLado || abaixo;
      })
      .map((o) => ({ ...o, d: Math.hypot(o.c.x - r.x, o.c.y - r.y) }))
      .sort((a, b) => a.d - b.d);
    return campos.length ? campos[0].el : null;
  }, rotulo);
  const el = mao.asElement();
  if (!el) throw new Error(`Nao achei o campo "${rotulo}" na tela`);
  return el;
}

// Campos de data do Protheus sao mascarados: trocar o .value nao avisa o
// servidor. Tem de digitar.
async function digitarNoCampo(page, rotulo, valor) {
  const campo = await campoDoRotulo(page, rotulo);
  await campo.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(valor, { delay: 60 });
  await pausa(400);
}

// Alguns parametros do 4XML ficam gravados POR USUARIO. Numa conta nova,
// "Apenas NF-e Empresa" vem como "Apenas Empresa" - e dai a colheita traz so
// uma empresa, que e exatamente como um ciclo voltou sem as notas da Forest.
// Avisar nao basta: o robo escolhe a opcao certa.
async function escolherNoCombo(page, rotulo, desejado) {
  const campo = await campoDoRotulo(page, rotulo);
  if (!campo) return "";
  const opcoes = await campo.evaluate((el) => (el.tagName.toLowerCase() === "select"
    ? [...el.options].map((o) => o.text) : [])).catch(() => []);
  const escolha = opcoes.find((t) => desejado.test(t));
  if (!escolha) return "";
  await campo.selectOption({ label: escolha }).catch(() => {});
  // O componente do Protheus so percebe a troca pelos eventos do <select>.
  await campo.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }).catch(() => {});
  await pausa(800);
  return (await valorDoCampo(page, rotulo)) || escolha;
}

async function valorDoCampo(page, rotulo) {
  const campo = await campoDoRotulo(page, rotulo);
  // Num combo o <select> guarda o indice ("1", "4"); quem tem o texto que o
  // usuario le e a opcao escolhida.
  return (await campo.evaluate((el) => {
    if (el.tagName.toLowerCase() === "select") return el.options[el.selectedIndex]?.text || el.value;
    return el.value;
  }).catch(() => "")).trim();
}

// O Protheus avisa erro em dialogo com botao "Fechar". Some sem bloquear o
// resto - e o 504 GatewayTimeout do meio da sincronizacao cai aqui.
// "Rotina ja esta sendo executada por outro usuario, verifique".
//
// O Protheus SERIALIZA a rotina do 4XML, e todas as maquinas entram com o
// mesmo usuario de integracao. Uma execucao abandonada - por erro, por
// limite de tempo, ou so por fechar o navegador no meio - deixa a rotina
// travada do lado do servidor, e a proxima encontra esta janela.
//
// Ate 28/10/2026 o robo fechava esse aviso em SILENCIO e seguia em frente:
// e por isso que a tela ficava dez minutos dizendo "Sincronizando com SEFAZ"
// sem nada acontecer, e por isso que as falhas vinham em cascata - a de
// 08:04 travou a de 08:12, que travou a colheita das 08:40.
const AVISO_TRAVADO = /rotina j.* sendo executada/i;

async function avisoTravando(page) {
  return (await textosVisiveis(page))
    .map((x) => String(x).replace(/<[^>]*>/g, "").trim())
    .some((x) => AVISO_TRAVADO.test(x));
}

async function fecharAvisos(page) {
  let fechados = 0;
  for (let i = 0; i < 5; i += 1) {
    // Tem de ser o wa-button do aviso: o "Fechar" de 17x17 no alto da tela
    // e o que fecha o Protheus inteiro.
    const fechar = page.locator('wa-button[caption="Fechar"]');
    if (!(await fechar.count().catch(() => 0))) break;
    // O filtro antigo era estreito demais e nao pegava justamente o aviso
    // que importa, que nao fala em erro nem em atencao.
    const texto = (await textosVisiveis(page))
      .map((x) => String(x).replace(/<[^>]*>/g, "").trim())
      .filter((x) => /erro|timeout|aten|n.o foi poss|rotina j|bloquead|indispon/i.test(x))
      .slice(0, 3).join(" | ");
    await fechar.first().click({ timeout: 8000 }).catch(() => {});
    fechados += 1;
    if (texto) diga("  aviso do Protheus:", texto);
    await pausa(2500);
  }
  return fechados;
}

// Sai pela porta, em vez de so fechar o navegador.
//
// Fechar a janela NAO encerra a sessao do Protheus: ela fica de pe ate o
// servidor desistir sozinho, e com ela fica a rotina do 4XML travada para
// todo mundo. Nunca interrompe o ciclo - se o botao nao estiver la, segue.
// Os dois erros que o fiscal encontra no meio da ressincronizacao, segundo
// a descricao dos videos: "504 GatewayTimeout" (com botao Fechar) e "Erro
// metodo ListarNFeSaida" (com botao OK). Nos dois casos o 4XML CONTINUA
// trabalhando depois que o aviso sai - mas enquanto ele estiver na tela,
// nada se mexe. Sem fechar, o robo leria essa imobilidade como "terminou".
//
// So clica quando ha UM botao de fechar dentro da mesma janelinha do texto
// de erro: e o que impede de acertar o "Cancelar" da barra de progresso ou
// um Ok de outra tela.
// Fecha uma janelinha do 4XML cujo texto casa com `padraoFonte` (origem de
// regex, sem barras), clicando no unico Ok/Fechar dela. Devolve o texto que
// fechou, ou "". fecharErro e fecharAvisoVazio sao so dois padroes deste
// mesmo mecanismo.
async function fecharJanela(page, padraoFonte) {
  return await page.evaluate((fonte) => {
    const ALVO = new RegExp(fonte, "i");
    const tudo = [];
    const visitar = (r) => {
      for (const e of r.querySelectorAll("*")) { tudo.push(e); if (e.shadowRoot) visitar(e.shadowRoot); }
    };
    visitar(document);
    const limpa = (t) => String(t || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const visivel = (e) => { const c = e.getBoundingClientRect(); return c.width > 0 && c.height > 0; };
    const rotulo = tudo.find((e) => e.tagName.toLowerCase() === "wa-text-view"
      && visivel(e) && ALVO.test(limpa(e.getAttribute("caption"))));
    if (!rotulo) return "";
    let no = rotulo;
    for (let i = 0; i < 8 && no; i += 1) {
      const botoes = [...no.querySelectorAll("wa-button")].filter((b) => visivel(b)
        && /^(fechar|ok)$/i.test(limpa(b.getAttribute("caption"))));
      if (botoes.length === 1) {
        // O que interessa e o texto DESTA JANELA, e nao o que casa com uma
        // lista de padroes conhecidos. Em 29/10/2026 o diario registrou tres
        // vezes so "Erro", porque o corpo da mensagem nao batia com nenhum
        // padrao - e sem ele ninguem sabe do que o 4XML reclamou.
        //
        // A janela e delimitada por geometria, e nao por querySelectorAll:
        // os rotulos moram em shadow roots diferentes e nao sao filhos do
        // no que segura o botao.
        const caixa = no.getBoundingClientRect();
        // Fora os rotulos de progresso. A janela de erro do 4XML cobre boa
        // parte da tela, entao a delimitacao por geometria varria junto o
        // "Gravando Notas Baixadas", o "Selecionando Registros" e companhia.
        // Em 29/10/2026 o diario saiu com cinco rotulos de espera antes do
        // que interessava, que era "TOTVS - 504 GatewayTimeout".
        const PROGRESSO = /carregando|dicion.rio de par|selecionando registros|gravando|processando|aguarde para utilizar/i;
        const dentro = [...new Set(tudo
          .filter((e) => e.tagName.toLowerCase() === "wa-text-view" && visivel(e))
          .filter((e) => {
            const c = e.getBoundingClientRect();
            return c.left >= caixa.left - 2 && c.right <= caixa.right + 2
              && c.top >= caixa.top - 2 && c.bottom <= caixa.bottom + 2;
          })
          .map((e) => limpa(e.getAttribute("caption")))
          .filter((t) => t && !PROGRESSO.test(t)))];
        botoes[0].click();
        return dentro.join(" - ") || limpa(rotulo.getAttribute("caption"));
      }
      no = no.parentElement || (no.getRootNode() && no.getRootNode().host);
    }
    return "";
  }, padraoFonte).catch(() => "");
}

// Aviso de erro do 4XML (GatewayTimeout, "Erro", "Nao foi possivel").
async function fecharErro(page) {
  return fecharJanela(page, "gatewaytimeout|erro m.todo|^erro$|n.o foi poss.vel");
}

// Aviso informativo de grade vazia: "Nao existem registros para esse Filtro"
// ou "Sem registros para o filtro selecionado". Nao e erro - o 4XML abre
// vazio e poe esse aviso por cima, tapando o botao do Espiao. Fechar e
// seguir: o Espiao e justamente quem vai buscar nota nova na SEFAZ.
async function fecharAvisoVazio(page) {
  return fecharJanela(page, "n.o existem registros|sem registros");
}

async function sairDoProtheus(page) {
  const saiu = await page.evaluate(() => {
    const tudo = [];
    const visitar = (r) => {
      for (const e of r.querySelectorAll("*")) { tudo.push(e); if (e.shadowRoot) visitar(e.shadowRoot); }
    };
    visitar(document);
    const limpa = (t) => String(t || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    // So o "Sair" da barra do alto: dentro das telas ha outros.
    const alvo = tudo.find((e) => {
      const c = e.getBoundingClientRect();
      return c.width > 0 && c.height > 0 && c.y < 80
        && /^(wa-button|wa-text-view|button|a|span)$/i.test(e.tagName)
        && limpa(e.getAttribute("caption") || e.getAttribute("title") || e.textContent) === "Sair";
    });
    if (!alvo) return false;
    alvo.click();
    return true;
  }).catch(() => false);
  if (!saiu) return false;
  await pausa(3000);
  // O Protheus confirma a saida numa janelinha.
  for (const nome of ["Sim", "Ok", "Confirmar"]) {
    const b = page.locator(`wa-button[caption="${nome}"]`).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 8000 }).catch(() => {}); break; }
  }
  await pausa(3000);
  return true;
}

// ---------- etapas ----------

// A tela que escolhe data base, grupo, filial e ambiente vem depois do
// login, num iframe proprio. E aqui que a filial e escolhida - mais firme do
// que o "Trocar Filial" de dentro do 4XML, que depende de achar a linha certa
// numa lista.
// Acha a janela de sessao esteja ela onde estiver: ora vem num iframe com
// "session-settings" na URL, ora na propria pagina. O sinal confiavel sao os
// tres lookups (Grupo, Filial, Ambiente) visiveis ao mesmo tempo.
async function quadroDeSessao(page) {
  for (const f of [...page.frames()]) {
    const lookups = f.locator("input[id^=po-lookup]");
    if ((await lookups.count().catch(() => 0)) < 3) continue;
    if (await lookups.nth(2).isVisible().catch(() => false)) return f;
  }
  return null;
}

async function escolherSessao(quadro, filial) {
  const lookups = quadro.locator("input[id^=po-lookup]");
  if ((await lookups.count().catch(() => 0)) < 3) return false;
  // Ordem na tela: Grupo, Filial, Ambiente.
  const campoFilial = lookups.nth(1);
  if ((await campoFilial.inputValue().catch(() => "")) !== filial.codigo) {
    await campoFilial.fill(filial.codigo);
    await quadro.locator("input[id^=po-lookup]").nth(2).click().catch(() => {});
    await pausa(2500);
  }
  // O ambiente (modulo) precisa ser escolhido E CONFERIDO. Tres coisas
  // diferentes aconteceram aqui entre 27 e 28/10/2026, todas por falta da
  // conferencia:
  //
  //   ficou "1"  -> o robo entrou no modulo errado e nao achou o menu 4XML
  //   ficou "2"  -> certo
  //   ficou "02" -> o campo ja vinha assim do login anterior, o robo achou
  //                 que estava bom e nao escreveu nada; o Protheus nunca
  //                 validou o codigo e a tela de sessao nao saiu mais da
  //                 frente - quatro cliques em "Entrar" sem sair do lugar.
  //
  // Por isso o config guarda o codigo JA normalizado ("2", e nao "02"): e o
  // que o Protheus devolve depois de validar, e so ele serve de prova.
  const campoAmbiente = lookups.nth(2);
  for (let i = 0; i < 3 && config.ambiente; i += 1) {
    if ((await campoAmbiente.inputValue().catch(() => "")) === config.ambiente) break;
    await campoAmbiente.fill(config.ambiente);
    await campoFilial.click().catch(() => {});
    await pausa(2500);
  }
  const ambiente = await campoAmbiente.inputValue().catch(() => "");
  diga(`  sessao: filial ${await campoFilial.inputValue().catch(() => "?")}, ambiente ${ambiente}`);
  // Entrar no modulo errado nao da erro: da uma falha confusa dois minutos
  // depois, no menu. Melhor parar aqui, dizendo o que houve.
  if (config.ambiente && ambiente !== config.ambiente) {
    throw new Error(`o ambiente ficou em "${ambiente}" e o 4XML so existe no ${config.ambiente} (Compras)`);
  }
  // O botao que fecha esta tela nao tem nome unico: em algumas contas sai
  // "Entrar", em outras "Confirmar". Tenta os dois, e so diz que resolveu se
  // algum deles aceitou o clique - senao o robo segue achando que esta
  // dentro do Protheus com a janela de sessao ainda aberta por cima.
  for (const nome of ["Confirmar", "Entrar"]) {
    const alvo = quadro.getByText(nome, { exact: true }).first();
    if (!(await alvo.count().catch(() => 0))) continue;
    if (await alvo.click({ timeout: 15000 }).then(() => true, () => false)) {
      diga(`  sessao confirmada em "${nome}"`);
      return true;
    }
  }
  return false;
}

async function entrar(page, filial) {
  diga("abrindo o Protheus");
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await pausa(12000);

  // Lancador: Programa Inicial / Ambiente ja vem certo; so confirmar.
  const ok = page.getByRole("button", { name: "Ok" });
  if (await ok.count().catch(() => 0)) {
    await ok.first().click({ timeout: 15000 }).catch(() => {});
    await pausa(15000);
  }

  // O formulario de login mora num iframe.
  let formulario = null;
  for (let i = 0; i < 12 && !formulario; i += 1) {
    for (const f of page.frames()) {
      if ((await f.locator("input[id^=po-password]").count().catch(() => 0)) >= 1) { formulario = f; break; }
    }
    if (!formulario) await pausa(5000);
  }
  if (!formulario) throw new Error("A tela de login nao apareceu");

  await formulario.locator("input[id^=po-login]").first().fill(USUARIO);
  await formulario.locator("input[id^=po-password]").first().fill(segredo("senha.dat", "PROTHEUS_SENHA"));
  await formulario.getByText("Entrar", { exact: false }).first().click({ timeout: 15000 });
  diga("entrando como", USUARIO, "na filial", filial.codigo);

  // Daqui ate o menu aparecer, o caminho tem obstaculos: o aviso de
  // "diretorio de impressao" (que vem quando o TOTVS WebAgent nao esta
  // instalado) e a tela de escolha de sessao.
  // A tela de sessao aparece mais de uma vez: uma conta sem ambiente
  // gravado ganha ainda a janela "TOTVS Linha Protheus", com os mesmos
  // campos e um botao "Confirmar". Por isso nao basta resolver a primeira e
  // parar de olhar - a cada volta o robo procura de novo.
  let sessoes = 0;
  for (let i = 0; i < 30; i += 1) {
    await pausa(5000);
    await fecharAvisos(page);
    // A janela "TOTVS Linha Protheus" (data base, grupo, filial, ambiente)
    // nao e feita dos mesmos campos da anterior: e a janela classica do
    // Protheus, e sai pelo botao Confirmar. Quem nao tem ambiente gravado
    // passa por ela toda vez que entra.
    if (await botao(page, "Confirmar").count().catch(() => 0)) {
      diga("  confirmando a janela de ambiente");
      await clicarCaption(page, "Confirmar", 10000).catch(() => {});
      continue;
    }
    const quadro = await quadroDeSessao(page);
    // Enquanto uma dessas janelas estiver na tela, o "Trocar modulo" la
    // atras nao significa que o robo ja esta dentro.
    if (!quadro && await botao(page, "Trocar módulo").count().catch(() => 0)) { diga("dentro do Protheus"); return; }
    if (quadro && sessoes < 4 && await escolherSessao(quadro, filial)) sessoes += 1;
  }
  throw new Error("O Protheus nao terminou de abrir");
}

// Os itens do menu trazem HTML no caption ("<u>A</u>tualizacoes (13)"), entao
// comparar texto cru nao adianta: limpa as tags antes de procurar.
// Espera o item aparecer antes de desistir: a arvore do menu se desenha em
// etapas, e um nivel recem-aberto leva uns segundos para listar os filhos.
async function clicarMenu(page, texto, tentativas = 6) {
  for (let i = 0; i < tentativas; i += 1) {
    if (await clicarMenuAgora(page, texto)) return true;
    await pausa(3000);
  }
  return false;
}

async function clicarMenuAgora(page, texto) {
  const mao = await page.evaluateHandle((alvo) => {
    const itens = [];
    const visitar = (raiz) => {
      for (const el of raiz.querySelectorAll("wa-menu-item")) itens.push(el);
      for (const el of raiz.querySelectorAll("*")) if (el.shadowRoot) visitar(el.shadowRoot);
    };
    visitar(document);
    const limpa = (t) => String(t || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    return itens.find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && limpa(el.getAttribute("caption")).includes(alvo.toLowerCase());
    }) || null;
  }, texto);
  const el = mao.asElement();
  if (!el) return false;
  await el.click({ timeout: 15000 });
  return true;
}

async function abrirGerenciador(page) {
  diga("abrindo o Gerenciador 4XML");
  // A arvore do menu abre fechada numa sessao nova, entao a busca do proprio
  // menu e o caminho curto: "Atualizacoes > 4XML > Gerenciador 4XML" exigiria
  // tres cliques que mudam de lugar conforme o perfil do usuario.
  const busca = page.locator('input[placeholder="Pesquisar"], input[title="Pesquisar"]').first();
  await busca.click({ timeout: 20000 });
  await busca.fill("Gerenciador 4XML");
  await page.keyboard.press("Enter");
  await pausa(5000);
  // Uma tentativa so: se a busca nao achou, o caminho e a arvore, nao esperar.
  if (!(await clicarMenu(page, "Gerenciador 4XML", 1))) {
    // Sem a busca, abre na unha: Atualizacoes > 4XML > Gerenciador 4XML.
    diga("  a busca do menu nao trouxe nada; abrindo a arvore");
    await busca.fill("");
    await page.keyboard.press("Enter");
    await pausa(3000);
    for (const passo of ["Atualiza", "4XML", "Gerenciador 4XML"]) {
      if (!(await clicarMenu(page, passo))) throw new Error(`Nao achei "${passo}" no menu`);
      await pausa(3000);
    }
  }
  await pausa(15000);
  // Ao abrir o programa, o Protheus pode pedir de novo data base, grupo,
  // filial e ambiente na janela "TOTVS Linha Protheus". Ela e modal: o
  // cartao do 4XML so e desenhado depois que ela sai.
  for (let i = 0; i < 3; i += 1) {
    if (!(await botao(page, "Confirmar").count().catch(() => 0))) break;
    diga("  confirmando a janela de ambiente");
    await clicarCaption(page, "Confirmar", 15000).catch(() => {});
  }
  // O menu do 4XML e uma imagem so (cexmpri.png): os botoes nao existem no
  // DOM, so em pixels. "Acessar NF-e" e o primeiro da pilha, a 32% da altura
  // do cartao - medido na tela em 22/10/2026 e conferido em duas resolucoes.
  const procurarCartao = () => page.evaluate(() => {
    const imagens = [];
    const visitar = (raiz) => {
      for (const el of raiz.querySelectorAll("wa-image")) imagens.push(el);
      for (const el of raiz.querySelectorAll("*")) if (el.shadowRoot) visitar(el.shadowRoot);
    };
    visitar(document);
    const cartao = imagens.find((el) => String(el.getAttribute("src") || "").includes("cexmpri"));
    if (!cartao) return null;
    const r = cartao.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.32) };
  });
  let alvo = await procurarCartao();
  for (let i = 0; i < 4 && !alvo; i += 1) { await pausa(8000); alvo = await procurarCartao(); }
  if (!alvo) throw new Error("O cartao do 4XML nao apareceu");
  await page.mouse.click(alvo.x, alvo.y);
  await pausa(15000);
  if (!(await page.locator('wa-text-view[caption="Parametros"]').count().catch(() => 0))) {
    throw new Error('A tela de Parametros nao abriu depois de "Acessar NF-e"');
  }
}

// Sincroniza uma filial com a SEFAZ. E a parte lenta: o fiscal relata ate 17
// minutos para as duas filiais, com um 504 no meio que nao interrompe o
// processo - so precisa fechar o aviso e esperar.
//
// A sequencia foi conferida na tela em 22/10/2026, e nao e a que a descricao
// do video sugeria:
//   Acoes > Espiao XML   -> abre a janela de FILTROS (mes, ano, dias, CNPJ)
//   Ok                   -> abre a GRADE do Espiao (nao a sincronizacao)
//   "Sincronizar com SEFAZ" (botao na lateral, rotulo no title, nao no caption)
//   Ok                   -> ai sim comeca
//
// Na janela de sincronizacao, "Sincronizar Pendentes" ja vem marcado: e a
// busca incremental, que e o que se quer duas vezes por dia. "Ressincronizar"
// relê um periodo inteiro e serve para recuperar, nao para a rotina.
// Mensagens que o 4XML mostra ENQUANTO ressincroniza, vistas no video do
// fiscal em 27/10/2026: "Ressincronizando notas", depois "Gravando Notas
// Baixadas" com barra de progresso, depois "Sincronizando com SEFAZ", e de
// novo a gravacao. Quando todas somem, acabou - uns 26 segundos no video.
//
// E proposital que "Selecionando Registros" NAO esteja aqui: esse rotulo
// fica preso na tela do Espiao e nunca sai, e foi ele que fez as esperas
// genericas estourarem o limite a cada ciclo.
// "gravando n" pega as DUAS mensagens que importam: "Gravando Notas
// Baixadas" (a etapa) e "Gravando NF/Sr: 010286754/001" (a nota da vez). A
// segunda e a unica coisa na tela que realmente ANDA - e e nela que o fim do
// trabalho se mede.
// "atualizando chave" e "procurando registros" entraram depois, com o video
// do fiscal de 28/10/2026: a gravacao das notas acaba, a grade do Espiao
// reaparece, e o 4XML AINDA esta trabalhando - atualizando a chave de cada
// documento embaixo, no lugar da legenda. Sem esses dois rotulos o robo via
// uma tela parada no meio do servico.
const EM_RESSINCRONIZACAO = /ressincronizando|gravando n|sincronizando com sefaz|processando|atualizando chave|procurando registros/i;

// Quanto tempo de tela IMOVEL ja conta como "acabou".
//
// Medido em 28/10/2026, sondando a tela de 3 em 3 segundos durante uma
// ressincronizacao de verdade (3 dias, 54 NF-e gravadas): enquanto havia
// trabalho, a tela NUNCA ficou parada mais de 15 segundos. Aos 4min28 ela
// congelou de vez e nao se mexeu mais nos 6 minutos seguintes. Noventa
// segundos sao seis vezes a maior pausa real.
const PARADO_MS = 90000;

// ...mas ha uma etapa em que a tela fica parada de proposito.
//
// "Sincronizando com SEFAZ" e so um circulo girando, sem porcentagem e sem
// numero de nota. No video do fiscal (22/10/2026) ela ficou assim por
// QUATRO MINUTOS seguidos. Com os 90 segundos acima o robo daria o
// trabalho por encerrado no meio da conversa com a SEFAZ e colheria uma
// grade incompleta - dizendo que deu tudo certo.
//
// Entao, enquanto esse rotulo estiver na tela, a paciencia e outra.
const ESPERANDO_SEFAZ = /sincronizando com sefaz/i;
const PARADO_NA_SEFAZ_MS = 360000;

async function esperarRessincronizacao(page, minutos) {
  const limite = Date.now() + minutos * 60000;
  let houveErro = false;
  const olhar = async () => (await textosVisiveis(page))
    .map((x) => String(x).replace(/<[^>]*>/g, "").trim())
    .filter((x) => EM_RESSINCRONIZACAO.test(x));

  // 1. esperar COMECAR. Sem isto, uma tela que ainda nao reagiu ao clique
  //    pareceria "ja terminou".
  let comecou = [];
  for (let i = 0; i < 60 && !comecou.length; i += 1) {
    if (await avisoTravando(page)) {
      diga("  PARADO: o Protheus diz que a rotina ja esta sendo executada por outro usuario.");
      diga("         Alguma execucao anterior ficou aberta no servidor; espere ela cair e rode de novo.");
      return false;
    }
    comecou = await olhar();
    if (!comecou.length) await pausa(1000);
  }
  if (!comecou.length) {
    // Sem sinal de trabalho: ou nao havia nada a fazer, ou o Ok nao pegou.
    // Sao coisas opostas, e tratar as duas como falha esconde a de verdade.
    // A janela aberta e a prova: se ela sumiu, o comando foi aceito.
    // DUAS opcoes visiveis, e nao "algum radio na tela". A janela de
    // sincronizacao tem exatamente duas (Pendentes e Ressincronizar) - e o
    // mesmo sinal que escolherRessincronizar usa para se reconhecer. Contar
    // qualquer radio confundia a janela aberta com um radio solto de outra
    // tela, e o robo acusava "o Ok nao pegou" numa filial que simplesmente
    // nao tinha nada a buscar (Forest, 28/10/2026 10:15, vinte minutos
    // depois de ela ja ter sido sincronizada).
    const radios = await page.evaluate(() => {
      const tudo = [];
      const visitar = (r) => {
        for (const e of r.querySelectorAll("*")) { tudo.push(e); if (e.shadowRoot) visitar(e.shadowRoot); }
      };
      visitar(document);
      return tudo.filter((e) => e.tagName.toLowerCase() === "input" && e.type === "radio"
        && e.getBoundingClientRect().width > 0).length;
    }).catch(() => 0);
    if (radios === 2) {
      diga("  ATENCAO: a janela de sincronizacao continua aberta; o Ok nao pegou");
      // Em 28/10/2026 isto aconteceu na Forest e eu nao soube dizer por que:
      // o clique nao deu erro, e o fiscal confirmou que ha um unico Ok na
      // tela. Da proxima vez o diario conta o que estava la, em vez de
      // deixar a resposta por conta do palpite de quem ler.
      const foto = await fotoDaTela(page);
      diga(`    botoes na tela: ${foto.botoes.join(" | ") || "(nenhum)"}`);
      diga(`    textos na tela: ${foto.textos.slice(0, 25).join(" | ") || "(nenhum)"}`);
      return false;
    }
    // O numero vai para o diario de proposito: se um dia este palpite
    // estiver errado, e ele que vai dizer.
    diga(`  a ressincronizacao terminou sem nada a trazer (${radios} opcoes na tela)`);
    return true;
  }
  diga(`  ressincronizando: ${comecou[0]}`);

  // 2. esperar TERMINAR - e "terminar" NAO e as mensagens sumirem.
  //
  // Esse era o erro, e custou dez minutos por filial em todo ciclo desde
  // 27/10/2026. Quando a ressincronizacao acaba, o 4XML NAO limpa a tela:
  // os rotulos de progresso ficam congelados na ultima nota gravada, para
  // sempre, exatamente como "Selecionando Registros" e o splash. Esperar
  // eles sumirem e esperar uma coisa que nunca acontece - e por isso 3 dias
  // e um mes inteiro demoravam os mesmos dez minutos.
  //
  // O que distingue trabalhando de terminado nao e a PRESENCA do rotulo, e
  // o MOVIMENTO dele: "Gravando NF/Sr: ..." troca de numero a cada nota.
  // Entao o fim se mede pela tela parar de mudar.
  const inicio = Date.now();
  let retrato = comecou.join(" | ");
  let desde = Date.now();
  while (Date.now() < limite) {
    if (await avisoTravando(page)) {
      diga("  PARADO: o Protheus diz que a rotina ja esta sendo executada por outro usuario.");
      return false;
    }
    // Um erro na tela congela tudo ate alguem fechar. Fecha, registra, e
    // devolve a contagem ao zero: o trabalho continua depois dele.
    const erro = await fecharErro(page);
    if (erro) {
      diga(`  erro do 4XML durante a ressincronizacao: ${erro} (fechado, o trabalho segue)`);
      houveErro = true;
      desde = Date.now();
      await pausa(3000);
      continue;
    }
    const visiveis = await olhar();
    const agora = visiveis.join(" | ");
    if (agora !== retrato) { retrato = agora; desde = Date.now(); }
    const naSefaz = visiveis.some((x) => ESPERANDO_SEFAZ.test(x));
    if (Date.now() - desde >= (naSefaz ? PARADO_NA_SEFAZ_MS : PARADO_MS)) {
      diga(`  ressincronizacao terminada em ${Math.round((desde - inicio) / 1000)}s`
        + (houveErro ? " - COM erro pelo caminho, pode ter vindo nota a menos" : ""));
      return true;
    }
    await pausa(3000);
  }
  diga(`  ATENCAO: passou de ${minutos} min ressincronizando e nao terminou`);
  return false;
}



// Clica o Espiao XML passando POR CIMA de qualquer aviso que esteja tapando
// o botao. O 4XML abre a grade principal com um filtro padrao; quando ela
// volta vazia, sobe "Nao existem registros para esse Filtro" por cima, e o
// clique nao enxerga o botao ("element is not visible") - foi o que travou as
// duas filiais em 03/11/2026, com a grade vazia do fim de semana (fotos em
// logs/erro-*.png). O Espiao NAO pode depender de a grade principal ter nota:
// ele e quem vai buscar nota nova na SEFAZ. Entao: fecha o aviso, registra, e
// roda o Espiao assim mesmo.
async function clicarEspiao(page) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= 4; tentativa += 1) {
    const vazio = await fecharAvisoVazio(page);
    if (vazio) diga(`  o 4XML avisou "${vazio}"; fechei e vou rodar o Espiao assim mesmo`);
    const falha = await fecharErro(page);
    if (falha) diga(`  o 4XML mostrou "${falha}"; fechei e segui`);
    if (vazio || falha) await pausa(1500);
    try {
      const alvo = botao(page, "Espião XML");
      await alvo.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
      await alvo.click({ timeout: 8000 });
      await pausa(9000);
      return;
    } catch (err) {
      ultimoErro = err;
      await pausa(2000);
    }
  }
  throw new Error(`nao consegui clicar no Espiao XML depois de fechar os avisos: ${ultimoErro?.message || ultimoErro}`);
}

async function sincronizar(page, filial) {
  diga(`sincronizando a filial ${filial.nome}`);
  await clicarEspiao(page);

  // A janela da ressincronizacao e CURTA, e nao o mes inteiro.
  //
  // Medido em 27/10/2026: o mes todo passou de 12 minutos sem terminar; o
  // dia, no video do fiscal, leva 26 segundos. Alguns dias de folga pegam
  // nota que chega atrasada sem pagar o preco do mes.
  //
  // A COLHEITA continua olhando o mes inteiro - sao coisas diferentes:
  // ressincronizar busca na SEFAZ, colher le o que ja esta no 4XML.
  const dias = Math.max(1, Number(config.diasParaRessincronizar) || 3);
  const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const inicio = new Date(hoje.getTime() - (dias - 1) * 86400000);
  // Virando o mes, nao da para pedir "dia 29 a 02" na mesma tela: o filtro
  // tem mes unico. Nesse caso comeca no dia 1.
  const diaDe = inicio.getMonth() === hoje.getMonth() ? String(inicio.getDate()).padStart(2, "0") : "01";
  const diaAte = String(hoje.getDate()).padStart(2, "0");

  // O FILTRO DO ESPIAO E A JANELA DA RESSINCRONIZACAO SAO COISAS SEPARADAS.
  //
  // O filtro monta a grade; a janela diz o periodo a buscar na SEFAZ. O robo
  // usava os mesmos tres dias nos dois, e foi isso que derrubou a Forest em
  // 28/10/2026: filtrada por 26 a 28, a grade dela voltou "Sem registros
  // para o filtro selecionado" (foto em logs/erro-010101-*.png) e, sem
  // grade, o 4XML nao abre a janela de sincronizacao - radios: 0. A Onze
  // passava porque tinha nota no periodo, e em 27/10, com o filtro do mes
  // inteiro, a propria Forest ressincronizou sem reclamar.
  //
  // No video do fiscal (28/10/2026) a grade mostra notas de 01, 07, 09, 16 e
  // 25 de outubro e mesmo assim ele ressincroniza so o dia 28: a grade larga
  // nao alarga o trabalho. Entao o filtro vai do dia 1, e so a janela fica
  // curta.
  await digitarNoCampo(page, "Ano", String(hoje.getFullYear()));
  await digitarNoCampo(page, "Dia de", "01");
  await digitarNoCampo(page, "Dia Até", diaAte);
  diga("  filtros do Espiao:", `mes ${await valorDoCampo(page, "Mês")},`,
    `${await valorDoCampo(page, "Dia de")} a ${await valorDoCampo(page, "Dia Até")}`);
  await page.locator('wa-button[caption="Ok"]').first().click({ timeout: 20000 });

  // A grade do Espiao demora a desenhar. Esperar o "ocupado" sumir nao
  // serve: "Selecionando Registros" fica preso ali para sempre. O que o
  // robo precisa e o botao.
  if (!(await esperarRotulo(page, "Sincronizar com SEFAZ", config.minutosGradeEspiao || 12))) {
    throw new Error('Nao achei o botao "Sincronizar com SEFAZ" na grade do Espiao');
  }
  await clicarRotulo(page, "Sincronizar com SEFAZ");
  await pausa(8000);

  // RESSINCRONIZAR, e nao "Sincronizar Pendentes".
  //
  // "Pendentes" vem marcado por padrao e so trata o que o 4XML ja conhece
  // como pendente - nao sai procurando nota nova na SEFAZ. Eu assumi o
  // contrario em 22/10/2026, a partir de um video, e escrevi isso no LEIAME
  // como se fosse fato: o robo passou cinco dias clicando no botao errado.
  const deBr = `${diaDe}/${String(hoje.getMonth() + 1).padStart(2, "0")}/${hoje.getFullYear()}`;
  const ateBr = dataBr(0);
  const escolha = await escolherRessincronizar(page, deBr, ateBr);
  if (!escolha?.ressincronizarMarcado) {
    // Quando a janela nao abre, quase sempre ha um aviso do 4XML por cima
    // dizendo o motivo ("I/O error", "Rotina ja esta sendo executada").
    // Sem ler esse texto, o diario so registrava "a janela nao tem as duas
    // opcoes", que nao ajuda ninguem a entender o que houve.
    const naTela = await fecharErro(page);
    throw new Error(`nao consegui abrir a sincronizacao: ${JSON.stringify(escolha)}`
      + (naTela ? ` - o 4XML respondeu: ${naTela}` : ""));
  }
  // Ler a janela DE NOVO, do zero. O que escolherRessincronizar devolve e o
  // que ela mesma acabou de escrever: se o campo de data do Protheus ignorar
  // a escrita, o diario anuncia um periodo e o 4XML recebe outro. E a janela
  // abre com a data inicial um MES atras (28/09 quando era 28/10, video do
  // fiscal de 28/10/2026), entao uma escrita perdida nao e detalhe - vira
  // uma ressincronizacao do mes inteiro sem ninguem perceber.
  await pausa(1500);
  const janela = await lerSincronizacao(page);
  if (!janela.marcado) {
    throw new Error("Ressincronizar nao ficou marcado na janela; o pedido iria como "
      + `Sincronizar Pendentes, que nao busca nota nova (${JSON.stringify(janela)})`);
  }
  if (janela.de !== deBr || janela.ate !== ateBr) {
    diga(`  ATENCAO: pedi ${deBr} a ${ateBr} e a janela ficou em `
      + `${janela.de || "?"} a ${janela.ate || "?"}`);
  }
  diga(`  Ressincronizar marcado, periodo ${janela.de} a ${janela.ate}`);

  const confirmar = page.locator('wa-button[caption="Ok"]');
  if (!(await confirmar.count().catch(() => 0))) throw new Error("A janela Sincronizar SEFAZ nao abriu");
  await confirmar.last().click({ timeout: 20000 });

  // Agora HA sinal de termino, porque agora ha trabalho acontecendo.
  const terminou = await esperarRessincronizacao(page, config.minutosSincronizacao || 10);
  diga(terminou
    ? `  filial ${filial.nome} ressincronizada`
    : `  filial ${filial.nome}: a ressincronizacao nao confirmou o fim`);
  return terminou;
}


// Espera um botao aparecer, fechando os avisos do caminho. Diferente de
// esperar o Protheus "ficar quieto", isto termina no instante em que o que
// interessa chega - e so gasta o limite quando ele de fato nao chegou.
async function esperarRotulo(page, texto, minutos) {
  const inicio = Date.now();
  let avisado = false;
  while (Date.now() - inicio < minutos * 60000) {
    await fecharAvisos(page);
    if (await acharRotulo(page, texto)) return true;
    // Um recado depois do primeiro minuto, uma vez so: quem olha o diario
    // precisa saber que o robo esta esperando, e nao travado.
    if (!avisado && Date.now() - inicio > 60000) {
      diga(`  ainda esperando "${texto}" aparecer`);
      avisado = true;
    }
    await pausa(5000);
  }
  diga(`  ATENCAO: "${texto}" nao apareceu em ${minutos} min`);
  return false;
}

// Marca "Ressincronizar" na janela de sincronizacao e escreve o periodo.
//
// "Sincronizar Pendentes", que vem marcado por padrao, so trata o que o
// 4XML ja conhece como pendente - nao sai procurando nota nova na SEFAZ.
// Quem traz as notas do periodo e o Ressincronizar, que e o que o fiscal
// usa na mao. Conferido com foto em 27/10/2026.
async function escolherRessincronizar(page, de, ate) {
  const estado = await page.evaluate(({ de: dde, ate: aate }) => {
    const tudo = [];
    const visitar = (r) => {
      for (const e of r.querySelectorAll("*")) { tudo.push(e); if (e.shadowRoot) visitar(e.shadowRoot); }
    };
    visitar(document);
    const visivel = (e) => { const c = e.getBoundingClientRect(); return c.width > 0 && c.height > 0; };
    const radios = tudo.filter((e) => e.tagName.toLowerCase() === "input" && e.type === "radio" && visivel(e));
    // A janela tem exatamente dois: Pendentes (0) e Ressincronizar (1).
    if (radios.length !== 2) return { radios: radios.length, erro: "a janela nao tem as duas opcoes" };
    const alvo = radios[1];
    alvo.click();

    // As datas sao os dois campos ao lado, no formato dd/mm/aaaa.
    const datas = tudo.filter((e) => e.tagName.toLowerCase() === "input" && e.type !== "radio" && visivel(e)
      && /^\s*\d{2}\/\d{2}\/\d{4}\s*$/.test(e.value || ""));
    const escrever = (campo, valor) => {
      if (!campo) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(campo, valor);
      for (const nome of ["input", "change", "blur"]) campo.dispatchEvent(new Event(nome, { bubbles: true }));
    };
    escrever(datas[0], dde);
    escrever(datas[1], aate);
    return {
      ressincronizarMarcado: radios[1].checked,
      pendentesMarcado: radios[0].checked,
      campos: datas.length,
      de: datas[0]?.value || "",
      ate: datas[1]?.value || "",
    };
  }, { de, ate });
  return estado;
}

// Le a janela de sincronizacao do zero, sem escrever nada. Serve para
// conferir o que o Protheus guardou, e nao o que o robo mandou.
async function lerSincronizacao(page) {
  return page.evaluate(() => {
    const tudo = [];
    const visitar = (r) => {
      for (const e of r.querySelectorAll("*")) { tudo.push(e); if (e.shadowRoot) visitar(e.shadowRoot); }
    };
    visitar(document);
    const visivel = (e) => { const c = e.getBoundingClientRect(); return c.width > 0 && c.height > 0; };
    const radios = tudo.filter((e) => e.tagName.toLowerCase() === "input" && e.type === "radio" && visivel(e));
    const datas = tudo.filter((e) => e.tagName.toLowerCase() === "input" && e.type !== "radio" && visivel(e)
      && /^\s*\d{2}\/\d{2}\/\d{4}\s*$/.test(e.value || ""));
    return {
      radios: radios.length,
      marcado: radios.length === 2 ? radios[1].checked : false,
      de: datas[0]?.value || "",
      ate: datas[1]?.value || "",
    };
  }).catch(() => ({ radios: 0, marcado: false, de: "", ate: "" }));
}

// Tudo o que esta visivel, em duas linhas. So e chamada quando algo deu
// errado: e o que falta para o diario explicar a falha sozinho.
async function fotoDaTela(page) {
  const botoes = await page.evaluate(() => {
    const todos = [];
    const visitar = (r) => {
      for (const e of r.querySelectorAll("wa-button")) todos.push(e);
      for (const e of r.querySelectorAll("*")) if (e.shadowRoot) visitar(e.shadowRoot);
    };
    visitar(document);
    return todos.filter((e) => { const c = e.getBoundingClientRect(); return c.width > 0 && c.height > 0; })
      .map((e) => (e.getAttribute("caption") || e.getAttribute("title") || "?").trim());
  }).catch(() => []);
  const textos = (await textosVisiveis(page))
    .map((x) => String(x).replace(/<[^>]*>/g, "").trim()).filter(Boolean);
  return { botoes, textos };
}

// Alguns botoes do 4XML trazem o rotulo no title, e nao no caption - o
// "Sincronizar com SEFAZ" e um deles.
function acharRotulo(page, texto) {
  return page.evaluateHandle((alvo) => {
    const todos = [];
    const visitar = (r) => {
      for (const e of r.querySelectorAll("wa-button")) todos.push(e);
      for (const e of r.querySelectorAll("*")) if (e.shadowRoot) visitar(e.shadowRoot);
    };
    visitar(document);
    return todos.find((e) => {
      const c = e.getBoundingClientRect();
      const rot = `${e.getAttribute("caption") || ""} ${e.getAttribute("title") || ""}`.toLowerCase();
      return c.width > 0 && c.height > 0 && rot.includes(alvo.toLowerCase());
    }) || null;
  }, texto).then((mao) => mao.asElement());
}

async function clicarRotulo(page, texto) {
  const el = await acharRotulo(page, texto);
  if (!el) return false;
  await el.click({ timeout: 15000 });
  return true;
}

// Espera as mensagens de progresso sumirem ("Gravando Notas Recebidas",
// "Sincronizando com SEFAZ", "Ressincronizando notas"), fechando os avisos
// que aparecerem pelo caminho.
const OCUPADO = /aguarde|gravando|sincroniz|processand|procurando registros/i;

async function esperarProcessamento(page, minutos) {
  const limite = Date.now() + minutos * 60000;
  let quieto = 0;
  let segurando = [];
  while (Date.now() < limite) {
    await fecharAvisos(page);
    segurando = (await textosVisiveis(page))
      .map((x) => String(x).replace(/<[^>]*>/g, "").trim())
      .filter((x) => OCUPADO.test(x));
    if (!segurando.length) { quieto += 1; if (quieto >= 3) return true; } else quieto = 0;
    await pausa(10000);
  }
  // Dizer QUAIS textos seguraram a espera, e nao so que ela estourou: se for
  // sempre o mesmo rotulo, ele e fixo na tela e a espera nunca terminaria -
  // e isso e invisivel sem esta linha.
  diga(`  ATENCAO: passou de ${minutos} min esperando e o Protheus nao disse que terminou`);
  if (segurando.length) diga(`    o que segurou: ${[...new Set(segurando)].slice(0, 4).join(" | ")}`);
  return false;
}

// Reabre os Parametros da tela de NF-e com o periodo que queremos colher.
async function filtrarPeriodo(page, de, ate) {
  const temParametros = await page.locator('wa-text-view[caption="Parametros"]').count().catch(() => 0);
  if (!temParametros) await clicarCaption(page, "Filtro", 9000);
  await digitarNoCampo(page, "Emissão de", de);
  await digitarNoCampo(page, "Emissão até", ate);
  diga("  periodo:", await valorDoCampo(page, "Emissão de"), "a", await valorDoCampo(page, "Emissão até"));
  for (const [rotulo, desejado, nome] of [
    ["Apenas NF-e Empresa", /todas/i, "Todas Empresas"],
    ["Status da Nota", /todos/i, "Todos XML"],
  ]) {
    const atual = await valorDoCampo(page, rotulo);
    if (desejado.test(atual)) continue;
    const novo = await escolherNoCombo(page, rotulo, desejado);
    if (desejado.test(novo)) diga(`  "${rotulo}" estava "${atual}"; troquei para "${novo}"`);
    else diga(`  ATENCAO: "${rotulo}" esta "${atual}" e nao consegui deixar em "${nome}"`);
  }
  await page.getByRole("button", { name: "OK" }).first().click({ timeout: 20000 });
  await esperarProcessamento(page, 5);
}

// Le a grade inteira. O componente guarda so as linhas visiveis e busca o
// proximo bloco no servidor a cada PageDown. Para saber quando acabou sem
// chutar, o robo primeiro vai ao fim (Ctrl+End), anota a ultima nota, volta
// ao inicio e rola ate reve-la. Sem isso, uma resposta lenta do servidor
// parece fim de lista - foi assim que uma leitura trouxe 184 de 202.
async function colherGrade(page) {
  const casa = (await textosVisiveis(page)).map((x) => /Total de Registros\s*(\d+)/i.exec(x)).find(Boolean);
  const total = casa ? Number(casa[1]) : 0;
  diga(`  a tela diz ${total || "?"} registros`);

  const centro = await page.evaluate(() => {
    const el = document.querySelector("wa-tcbrowse");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + 200), y: Math.round(r.y + 30) };
  });
  if (!centro) throw new Error("A grade de NF-e nao esta na tela");

  const ler = () => page.evaluate(() => {
    const el = document.querySelector("wa-tcbrowse");
    return el ? el.rows.map((r) => r.data.map((v) => String(v).trim())) : [];
  }).catch(() => []);

  const porChave = new Map();
  const guardar = (linhas) => {
    for (const linha of linhas) {
      const chave = String(linha[7] || "").replace(/\D+/g, "");
      if (chave.length === 44) porChave.set(chave, linha);
    }
  };

  // Marca de fim: a ultima nota da lista.
  await page.mouse.click(centro.x, centro.y);
  await pausa(1500);
  await page.keyboard.press("Control+End");
  await pausa(4000);
  const fim = await ler();
  guardar(fim);
  const ultima = fim.length ? String(fim[fim.length - 1][7] || "").replace(/\D+/g, "") : "";
  if (!ultima) diga("  nao consegui marcar o fim da lista; vou pela contagem");

  await page.keyboard.press("Control+Home");
  await pausa(4000);

  let anterior = "";
  let paradas = 0;
  const limite = Math.max(60, (total || 600) + 40);
  for (let i = 0; i < limite; i += 1) {
    const atual = await ler();
    guardar(atual);
    // A parada olha o bloco que esta na tela, nao o que ja foi guardado: a
    // ultima nota entrou no mapa la no comeco, quando fomos marcar o fim.
    const chegouAoFim = ultima && atual.some((l) => String(l[7] || "").replace(/\D+/g, "") === ultima);
    if (chegouAoFim) break;
    if (total && porChave.size >= total) break;

    const marca = atual.length ? atual[0][4] : "";
    await page.keyboard.press("PageDown");
    // Espera o bloco realmente trocar, em vez de confiar num tempo fixo: sem
    // janela o servidor responde mais devagar.
    let mudou = false;
    for (let t = 0; t < 10 && !mudou; t += 1) {
      await pausa(300);
      const depois = await ler();
      mudou = depois.length > 0 && depois[0][4] !== marca;
      if (mudou) guardar(depois);
    }
    if (!mudou) { paradas += 1; if (paradas >= 8) break; } else paradas = 0;
  }

  diga(`  li ${porChave.size} notas distintas`);
  if (total && porChave.size < total * 0.98) {
    diga(`  ATENCAO: a tela prometia ${total} e li ${porChave.size}`);
  }
  return [...porChave.values()];
}

// A grade nao tem coluna de valor: ele so aparece no quadro "Total XML" da
// nota selecionada. Entao, depois de colher as linhas, o robo percorre a
// grade de novo linha a linha e anota o valor de cada uma.
//
// Duas armadilhas, descobertas medindo na tela em 22/10/2026:
//
// 1. O "Total XML" chega DEPOIS da linha. Ler assim que a linha muda entrega
//    o valor da nota ANTERIOR - o erro passa despercebido porque o numero e
//    plausivel. Por isso a espera e pelo VALOR mudar, nao pela linha.
// 2. Quando duas notas seguidas tem o mesmo valor, o valor nao muda e a
//    espera termina por tempo. Nesse caso o robo espera mais um pouco e
//    confere de novo, para nao confundir "sao iguais" com "ainda nao chegou".
async function valoresDaGrade(page, linhas, jaTem = new Set()) {
  const limite = Number(process.env.MAX_VALORES) || Number(config.maxValores) || 400;
  const faltando = linhas.filter((l) => { const c = chaveDaLinha(l); return c && !jaTem.has(c); }).length;
  if (jaTem.size) diga(`  o portal ja sabe o valor de ${jaTem.size}; preciso ler ${faltando}`);
  else diga(`  lendo o valor das ${linhas.length} notas`);
  if (faltando > limite) diga(`  valores: vou ler ${limite} de ${faltando} (limite de config.maxValores)`);

  const ler = () => page.evaluate(() => {
    const tudo = [];
    const visitar = (r) => { for (const e of r.querySelectorAll("*")) { tudo.push(e); if (e.shadowRoot) visitar(e.shadowRoot); } };
    visitar(document);
    const limpa = (t) => String(t || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const rot = tudo.find((e) => e.tagName.toLowerCase() === "wa-text-view"
      && limpa(e.getAttribute("caption")).startsWith("total xml"));
    let total = "";
    if (rot) {
      const r = rot.getBoundingClientRect(), meio = r.y + r.height / 2;
      const campo = tudo.filter((e) => e.tagName.toLowerCase() === "input")
        .map((e) => ({ e, c: e.getBoundingClientRect() }))
        .filter(({ c }) => c.width > 0 && c.y < meio && c.y + c.height > meio && c.x > r.x && c.x - r.right < 260)
        .sort((a, z) => a.c.x - z.c.x)[0];
      total = campo ? campo.e.value.trim() : "";
    }
    const g = document.querySelector("wa-tcbrowse");
    const i = g?.current?.row ?? 0;
    const l = g?.rows?.[i];
    // Enquanto o Protheus carrega os itens da nota, o buffer de linhas fica
    // menor do que a tela e rows[current.row] nao existe. Nao e fim de lista:
    // e leitura que ainda nao vale.
    return { chave: l ? String(l.data[7]).replace(/\D+/g, "") : "", total, pronto: Boolean(l) };
  }).catch(() => ({ chave: "", total: "", pronto: false }));

  // Avanca uma linha. Insiste quando nao sai do lugar: uma resposta lenta do
  // servidor nao pode ser confundida com fim da lista - foi assim que uma
  // leitura parou em 261 de 611 notas.
  // "Aguarde carregando itens...." aparece a cada linha: e o Protheus
  // buscando os itens da nota. Teclar por cima disso enfileira movimentos e
  // pula notas.
  const carregando = () => page.evaluate(() => {
    const t = [];
    const visitar = (r) => {
      for (const e of r.querySelectorAll("wa-text-view")) {
        const c = e.getBoundingClientRect();
        if (c.width > 0 && c.height > 0) t.push(e.getAttribute("caption") || "");
      }
      for (const e of r.querySelectorAll("*")) if (e.shadowRoot) visitar(e.shadowRoot);
    };
    visitar(document);
    return t.some((x) => /carregando itens/i.test(x));
  }).catch(() => false);

  async function avancar(anterior) {
    for (let tentativa = 0; tentativa < 3; tentativa += 1) {
      while (await carregando()) await pausa(120);
      await page.keyboard.press("ArrowDown");
      let atual = anterior;
      // Paciencia longa: a demora e o Protheus carregando itens, nao fim de
      // lista. So uma leitura PRONTA e com outra chave conta como avanco.
      for (let i = 0; i < 100; i += 1) {
        await pausa(80);
        atual = await ler();
        if (atual.pronto && atual.chave && atual.chave !== anterior.chave) return atual;
      }
      await pausa(1500);
    }
    return anterior;
  }

  async function proxima(anterior) {
    let atual = await avancar(anterior);
    if (atual.chave === anterior.chave) return atual;
    // ATALHO REMOVIDO em 30/10/2026, e o motivo merece ficar escrito.
    //
    // Aqui havia um "se o portal ja sabe o valor, nao espera o painel
    // assentar". Economizava cerca de um segundo por nota ja conhecida - e
    // GRAVAVA VALOR ERRADO na nota seguinte.
    //
    // O painel de baixo ("Total XML") nao acompanha a grade na hora: ele
    // ainda mostra o total da linha anterior. A espera abaixo existe
    // exatamente para isso, e ela compara com o total de ANTES. Pulando a
    // espera numa nota conhecida, o "antes" guardado deixa de ser o que esta
    // na tela; na proxima nota desconhecida a comparacao dava diferente de
    // cara, e o valor aceito era o da nota anterior.
    //
    // Achado em 30/10/2026 com a DANFE na mao: a NF-e 3 serie 8 da
    // ALESSANDRA vale 4.145,00 e o portal mostrava 2.620,75 - enquanto os
    // 4.145,00 estavam gravados na NF-e 6. Um deslocamento de uma linha.
    //
    // E ele piorava conforme o robo acertava: com 780 das 799 notas ja
    // conhecidas, quase toda nota nova vinha logo depois de uma pulada.
    //
    // Velocidade de volta so com uma forma de confirmar que o painel e
    // DAQUELA linha - comparar com o total anterior nao serve quando o
    // anterior nao foi observado.
    for (let i = 0; i < 40 && atual.total === anterior.total; i += 1) {
      await pausa(60);
      const leitura = await ler();
      if (leitura.pronto) atual = leitura;
    }
    if (atual.total === anterior.total) {
      // Pode ser valor igual de verdade, ou servidor lento. Espera mais.
      await pausa(2000);
      const leitura = await ler();
      if (leitura.pronto) atual = leitura;
    }
    return atual;
  }

  const centro = await page.evaluate(() => {
    const r = document.querySelector("wa-tcbrowse").getBoundingClientRect();
    return { x: Math.round(r.x + 200), y: Math.round(r.y + 30) };
  });
  await page.mouse.click(centro.x, centro.y);
  await pausa(1200);
  await page.keyboard.press("Control+Home");
  await pausa(3000);

  const valores = {};
  const anotar = (linha) => {
    if (!linha.chave || !linha.total) return;
    const centavos = Math.round(Number(linha.total.replace(/\./g, "").replace(",", ".")) * 100);
    if (Number.isFinite(centavos) && centavos > 0) valores[linha.chave] = centavos;
  };

  let atual = await ler();
  // Onde a lista termina tem de ser perguntado a GRADE, nao a ordem em que as
  // notas foram colhidas: a varredura comeca indo ao fim para se orientar, e
  // por isso as ultimas linhas sao as PRIMEIRAS do mapa. Usar o ultimo item
  // do mapa como marca de fim fazia a leitura parar antes da hora e deixar de
  // fora justamente as notas mais recentes.
  await page.keyboard.press("Control+End");
  await pausa(4000);
  const ultima = (await ler()).chave;
  await page.keyboard.press("Control+Home");
  await pausa(3000);
  atual = await ler();
  if (!jaTem.has(atual.chave)) anotar(atual);
  // O teto conta o que foi LIDO na tela, nao as linhas percorridas: pular
  // uma nota ja conhecida nao custa quase nada, entao nao faz sentido gastar
  // a cota com ela.
  let lidas = jaTem.has(atual.chave) ? 0 : 1;
  // Quantas ainda faltam. Descer a grade custa cerca de um segundo por
  // linha, entao continuar depois da ultima nota que importa e tempo
  // jogado fora - em 27/10/2026 foram 11 minutos para ler 9 valores numa
  // grade de 675 linhas.
  let restam = faltando - lidas;
  for (let n = 1; n < linhas.length && lidas < limite; n += 1) {
    if (restam <= 0) { diga(`  li tudo o que faltava na linha ${n} de ${linhas.length}`); break; }
    if (atual.chave === ultima) break;
    const proximo = await proxima(atual);
    if (!proximo.chave || proximo.chave === atual.chave) {
      diga(`  a grade emperrou na nota ${n} de ${linhas.length}; sigo com o que li`);
      break;
    }
    // Pulada: o "Total XML" na tela ainda e o da anterior, entao anotar
    // aqui gravaria o valor errado na nota certa.
    if (!jaTem.has(proximo.chave)) { anotar(proximo); lidas += 1; restam -= 1; }
    atual = proximo;
  }
  diga(`  li o valor de ${Object.keys(valores).length} nota(s)`);
  return valores;
}

// A chave de acesso dentro de uma linha da grade.
//
// O que colherGrade devolve sao as CELULAS da linha, nao um objeto: a chave
// mora na coluna 7. Escrever linha.chave da undefined em silencio - foi o
// que fez a consulta ao portal sair com a lista vazia e nao perguntar nada.
const chaveDaLinha = (linha) => {
  const c = String(linha?.[7] ?? "").replace(/\D/g, "");
  return c.length === 44 ? c : "";
};

// As chaves cujo valor o portal ja tem. Se a consulta falhar, devolve vazio:
// o robo le tudo, como antes - mais lento, nunca errado.
async function valoresJaConhecidos(linhas) {
  if (SECO) return new Set();
  const chaves = linhas.map(chaveDaLinha).filter(Boolean);
  if (!chaves.length) return new Set();
  const destino = (process.env.PORTAL_URL || config.portal).replace(/\/+$/, "");
  try {
    const r = await fetch(`${destino}/api/nfe55/4xml/valores-conhecidos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${segredo("token.dat", "PORTAL_TOKEN")}`,
      },
      body: JSON.stringify({ chaves }),
    });
    if (!r.ok) throw new Error(`portal respondeu ${r.status}`);
    const d = await r.json();
    return new Set(Array.isArray(d?.comValor) ? d.comValor : []);
  } catch (err) {
    diga("  nao consegui saber quais valores o portal ja tem; vou ler todos:",
      String(err?.message || err).slice(0, 80));
    return new Set();
  }
}

async function enviarAoPortal(linhas, valores) {
  if (SECO) { diga(`modo seco: ${linhas.length} linhas NAO enviadas`); return; }
  // PORTAL_URL serve para apontar para um portal local em teste.
  const destino = (process.env.PORTAL_URL || config.portal).replace(/\/+$/, "");
  const pedido = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${segredo("token.dat", "PORTAL_TOKEN")}`,
    },
    body: JSON.stringify({ linhas, valores }),
  };

  // ESTA e a hora que nao pode falhar. Tudo o que o ciclo fez - ate meia
  // hora de Protheus e a leitura do valor de centenas de notas - vai embora
  // se a rede piscar justamente aqui. Em 26/10/2026 a maquina do fiscal
  // perdeu contato com o portal varias vezes ao longo do dia.
  //
  // Insistir so faz sentido quando o problema e passageiro: rede caida ou
  // erro do servidor. Se o portal RECUSA (token errado, linha invalida),
  // esperar nao conserta - e melhor falhar na hora e dizer por que.
  const ESPERAS = [10, 20, 40, 80, 160];
  let corpo = "";
  for (let tentativa = 0; ; tentativa += 1) {
    let passageiro = "";
    try {
      const resp = await fetch(`${destino}/api/nfe55/4xml`, pedido);
      corpo = await resp.text();
      if (resp.ok) break;
      if (resp.status < 500) throw new Error(`portal recusou (${resp.status}): ${corpo.slice(0, 200)}`);
      passageiro = `portal respondeu ${resp.status}`;
    } catch (err) {
      // fetch so lanca quando nao chegou ao servidor; a recusa acima e
      // relancada e sai daqui direto.
      if (err?.message?.startsWith("portal recusou")) throw err;
      passageiro = String(err?.message || err).slice(0, 120);
    }
    if (tentativa >= ESPERAS.length) {
      throw new Error(`nao consegui enviar ao portal depois de ${tentativa + 1} tentativas: ${passageiro}`);
    }
    diga(`  nao consegui enviar (${passageiro}); tentando de novo em ${ESPERAS[tentativa]}s`);
    await pausa(ESPERAS[tentativa] * 1000);
  }
  diga("portal:", corpo.slice(0, 200));
  // A linha que responde "a sincronizacao serviu para alguma coisa?".
  let resposta = {};
  try { resposta = JSON.parse(corpo) || {}; } catch { /* corpo nao-JSON ja apareceu acima */ }
  const novas = Number(resposta.novas);
  if (Number.isFinite(novas)) {
    diga(novas > 0 ? `  ${novas} nota(s) que o portal ainda nao tinha` : "  nenhuma nota nova desta vez");
  }
  const canceladas = Number(resposta.canceladas);
  if (Number.isFinite(canceladas) && canceladas > 0) {
    diga(`  ${canceladas} nota(s) cancelada(s) nesta leitura`);
  }
}

// ---------- ciclo ----------

// O periodo que o fiscal quer ver: do dia 1 do mes corrente ate hoje.
// Virando o mes, recomeca - no dia 1 a janela e de um dia so, e e isso
// mesmo. Pedido do Eliabe em 27/10/2026, no lugar dos 7 dias para tras.
function primeiroDiaDoMes() {
  const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return `01/${String(hoje.getMonth() + 1).padStart(2, "0")}/${hoje.getFullYear()}`;
}

function dataBr(diasAtras = 0) {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  d.setDate(d.getDate() - diasAtras);
  return d.toLocaleDateString("pt-BR");
}

// Cada filial roda na sua propria sessao do Protheus: a filial se escolhe no
// login, e isso evita depender do "Trocar Filial" no meio do 4XML. Sao uns 40
// segundos a mais por filial num ciclo que leva uns 20 minutos.
//
// Cada sessao sobe e derruba o SEU PROPRIO Chromium - nao e um unico
// navegador aberto o ciclo inteiro. Ate 11/11/2026 era um so, reaproveitado
// nas 4 entradas do ciclo (sincronizar x2, colher x2); os tres travamentos
// medidos (10/11 e duas vezes em 11/11) aconteceram sempre na ULTIMA
// entrada - a quarta - em pontos diferentes da tela (login, menu, leitura de
// grade), o que aponta para o navegador degradando com o tempo/uso, nao para
// um defeito num passo especifico (os laços de espera de cada passo sao
// limitados, conferido antes). Um Chromium novo por sessao custa uns 2
// segundos a mais por filial - nada, perto dos 20-40 minutos do ciclo - e
// elimina esse estado acumulado, seja ele qual for.
async function comSessao(filial, trabalho) {
  const navegador = await chromium.launch({
    executablePath: acharNavegador(),
    headless: !VISIVEL,
    args: ["--window-size=1500,950"],
  });
  const contexto = await navegador.newContext({ viewport: { width: 1500, height: 920 }, ignoreHTTPSErrors: true });
  const page = await contexto.newPage();
  // O Playwright ja fecha sozinho um dialogo nativo (alert/confirm) sem
  // handler - isso nao e para evitar travamento, e so para o diario contar
  // o que aconteceu, caso um dia apareca um e ninguem souber por que a tela
  // mudou sozinha no meio do ciclo.
  page.on("dialog", (dialog) => {
    diga(`  ATENCAO: dialogo inesperado do navegador (${dialog.type()}): ${dialog.message().slice(0, 200)}`);
    dialog.dismiss().catch(() => {});
  });
  try {
    await entrar(page, filial);
    await abrirGerenciador(page);
    return await trabalho(page);
  } catch (err) {
    const foto = join(PASTA_LOG, `erro-${filial.codigo}-${Date.now()}.png`);
    await page.screenshot({ path: foto }).catch(() => {});
    diga("  foto do erro em", foto);
    throw err;
  } finally {
    // Antes de fechar a janela, encerrar a sessao: ver sairDoProtheus.
    await sairDoProtheus(page).catch(() => {});
    await contexto.close().catch(() => {});
    await navegador.close().catch(() => {});
  }
}

// Olha a tela do Espiao e conta quais textos batem no filtro de "ocupado",
// de 20 em 20 segundos. Serve para descobrir se algum deles e FIXO: um
// rotulo que nunca sai faz a espera estourar o limite inteiro, toda vez, sem
// que o robo tenha como perceber. Nao mexe em nada - so olha.
async function sondarEspiao(page) {
  await page.getByRole("button", { name: "OK" }).first().click({ timeout: 20000 });
  await esperarProcessamento(page, 5);
  diga("abrindo o Espiao XML para sondar");
  await clicarCaption(page, "Espião XML", 9000);
  const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  await digitarNoCampo(page, "Ano", String(hoje.getFullYear()));
  await digitarNoCampo(page, "Dia de", "01");
  await digitarNoCampo(page, "Dia Até", "31");
  await page.locator('wa-button[caption="Ok"]').first().click({ timeout: 20000 });

  const amostra = async (quantas, rotulo) => {
    let anterior = "";
    for (let i = 0; i < quantas; i += 1) {
      const todos = (await textosVisiveis(page)).map((x) => String(x).replace(/<[^>]*>/g, "").trim());
      const batendo = [...new Set(todos.filter((x) => OCUPADO.test(x)))];
      const agora = batendo.join(" | ");
      // So registra quando MUDA: 25 minutos de linhas iguais nao ensinam nada,
      // e o que interessa e o instante em que algo aparece ou some.
      if (agora !== anterior) {
        diga(`  [${rotulo} ${i * 20}s] ${batendo.length ? batendo.map((x) => `"${x}"`).join(", ") : "NENHUM texto de ocupado"}`);
        anterior = agora;
      }
      await pausa(20000);
    }
  };

  // --ver-dialogo: para ANTES do Ok e mostra exatamente o que o robo tem
  // pela frente - quais opcoes a janela oferece e qual esta marcada. Em
  // 27/10/2026 ficou a duvida de o robo estar clicando em "Sincronizar
  // Pendentes" quando o certo seria "Ressincronizar".
  if (opcoes.has("--ver-dialogo")) {
    // A grade do Espiao leva uns 20s para desenhar; fotografar antes mostra
    // a tela de NF-e por tras e nao responde nada.
    if (!(await esperarRotulo(page, "Sincronizar com SEFAZ", 12))) {
      throw new Error('a grade do Espiao nao abriu: nao achei "Sincronizar com SEFAZ"');
    }
    await page.screenshot({ path: join(PASTA_LOG, "antes-de-sincronizar.png") });
    await clicarRotulo(page, "Sincronizar com SEFAZ");
    await pausa(10000);
    const janela = await page.evaluate(() => {
      const tudo = [];
      const visitar = (r) => {
        for (const e of r.querySelectorAll("*")) { tudo.push(e); if (e.shadowRoot) visitar(e.shadowRoot); }
      };
      visitar(document);
      const visivel = (e) => { const c = e.getBoundingClientRect(); return c.width > 0 && c.height > 0; };
      const limpa = (t) => String(t || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      return {
        radios: tudo.filter((e) => e.tagName.toLowerCase() === "input" && e.type === "radio" && visivel(e))
          .map((e) => ({ marcado: e.checked, valor: e.value, id: e.id })),
        textos: [...new Set(tudo.filter((e) => /wa-text-view|wa-radio|label/i.test(e.tagName) && visivel(e))
          .map((e) => limpa(e.getAttribute("caption") || e.textContent)).filter(Boolean))].slice(0, 25),
        campos: tudo.filter((e) => e.tagName.toLowerCase() === "input" && e.type !== "radio" && visivel(e))
          .map((e) => e.value).filter(Boolean).slice(0, 10),
        botoes: tudo.filter((e) => e.tagName.toLowerCase() === "wa-button" && visivel(e))
          .map((e) => limpa(e.getAttribute("caption") || e.getAttribute("title"))).filter(Boolean).slice(0, 12),
      };
    });
    diga("JANELA DE SINCRONIZACAO:");
    diga("  opcoes marcadas:", JSON.stringify(janela.radios));
    diga("  textos na tela :", JSON.stringify(janela.textos));
    diga("  campos         :", JSON.stringify(janela.campos));
    diga("  botoes         :", JSON.stringify(janela.botoes));
    await page.screenshot({ path: join(PASTA_LOG, "dialogo-sincronizar.png") });
    diga("  foto em", join(PASTA_LOG, "dialogo-sincronizar.png"));

    // Marca "Ressincronizar" e preenche o periodo, para ver se a janela
    // aceita - SEM confirmar.
    const marcou = await escolherRessincronizar(page, primeiroDiaDoMes(), dataBr(0));
    diga("  marcou Ressincronizar:", JSON.stringify(marcou));
    await page.screenshot({ path: join(PASTA_LOG, "dialogo-ressincronizar.png") });
    diga("  foto em", join(PASTA_LOG, "dialogo-ressincronizar.png"));
    return true;
  }

  await amostra(3, "grade");
  diga("disparando a sincronizacao para ver o que aparece e o que some");
  await clicarRotulo(page, "Sincronizar com SEFAZ");
  await pausa(8000);
  const confirmar = page.locator('wa-button[caption="Ok"]');
  if (!(await confirmar.count().catch(() => 0))) throw new Error("A janela Sincronizar SEFAZ nao abriu");
  await confirmar.last().click({ timeout: 20000 });
  diga("  sincronizacao disparada");
  await amostra(90, "sincronizando");
  return true;
}

// Olha a ressincronizacao de VERDADE, de perto. Dispara e depois, de 3 em 3
// segundos, conta o que cada rotulo de "ocupado" esta fazendo: se ainda tem
// tamanho na tela, se o navegador o considera visivel e se tem alguma coisa
// por cima dele. E a unica forma de separar "ainda trabalhando" de "rotulo
// que ficou preso" - nesta mesma tela isso ja aconteceu duas vezes, com o
// splash "Aguarde para utilizar" e com "Selecionando Registros".
async function sondarRessinc(page) {
  await page.getByRole("button", { name: "OK" }).first().click({ timeout: 20000 });
  await esperarProcessamento(page, 5);
  diga("abrindo o Espiao XML para sondar a ressincronizacao");
  await clicarCaption(page, "Espião XML", 9000);
  const dias = Math.max(1, Number(config.diasParaRessincronizar) || 3);
  const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const inicio = new Date(hoje.getTime() - (dias - 1) * 86400000);
  const diaDe = inicio.getMonth() === hoje.getMonth() ? String(inicio.getDate()).padStart(2, "0") : "01";
  await digitarNoCampo(page, "Ano", String(hoje.getFullYear()));
  await digitarNoCampo(page, "Dia de", diaDe);
  await digitarNoCampo(page, "Dia Até", String(hoje.getDate()).padStart(2, "0"));
  await page.locator('wa-button[caption="Ok"]').first().click({ timeout: 20000 });
  if (!(await esperarRotulo(page, "Sincronizar com SEFAZ", 12))) {
    throw new Error('a grade do Espiao nao abriu: nao achei "Sincronizar com SEFAZ"');
  }
  await clicarRotulo(page, "Sincronizar com SEFAZ");
  await pausa(8000);
  const deBr = `${diaDe}/${String(hoje.getMonth() + 1).padStart(2, "0")}/${hoje.getFullYear()}`;
  diga("  marcando Ressincronizar:", JSON.stringify(await escolherRessincronizar(page, deBr, dataBr(0))));
  await page.locator('wa-button[caption="Ok"]').last().click({ timeout: 20000 });
  diga("  Ok clicado; olhando a tela de 3 em 3 segundos");

  const t0 = Date.now();
  let anterior = "";
  for (let i = 0; i < 300; i += 1) {
    const retrato = await page.evaluate(() => {
      const tudo = [];
      const visitar = (r) => {
        for (const e of r.querySelectorAll("*")) { tudo.push(e); if (e.shadowRoot) visitar(e.shadowRoot); }
      };
      visitar(document);
      const limpa = (t) => String(t || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      const OCUPADO = /ressincroniz|gravando|sincronizando|aguarde|processando|selecionando|baixad/i;
      const rotulos = [];
      let total = "";
      for (const e of tudo) {
        if (e.tagName.toLowerCase() !== "wa-text-view") continue;
        const texto = limpa(e.getAttribute("caption"));
        if (!texto) continue;
        if (/Total de Registros/i.test(texto)) total = texto;
        if (!OCUPADO.test(texto)) continue;
        const c = e.getBoundingClientRect();
        const raiz = e.getRootNode();
        let cobertoPor = null;
        if (c.width > 0 && c.height > 0 && typeof raiz.elementFromPoint === "function") {
          const emCima = raiz.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
          if (emCima && !(e === emCima || e.contains(emCima))) cobertoPor = emCima.tagName.toLowerCase();
        }
        rotulos.push({
          t: texto.slice(0, 60),
          caixa: `${Math.round(c.width)}x${Math.round(c.height)}`,
          cssVisivel: typeof e.checkVisibility === "function"
            ? e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) : null,
          cobertoPor,
        });
      }
      return { rotulos, total };
    }).catch((e) => ({ rotulos: [], total: `ERRO ${e.message}` }));

    const agora = JSON.stringify(retrato);
    if (agora !== anterior) {
      const s = Math.round((Date.now() - t0) / 1000);
      diga(`  [${s}s] ${retrato.total || "sem total"}`);
      if (!retrato.rotulos.length) diga("        NENHUM rotulo de ocupado na tela");
      for (const r of retrato.rotulos) {
        diga(`        "${r.t}" caixa=${r.caixa} cssVisivel=${r.cssVisivel} coberto=${r.cobertoPor || "nao"}`);
      }
      anterior = agora;
    }
    await pausa(3000);
  }
  return true;
}

try {
  diga(`=== ciclo iniciado (robo ${VERSAO}) ===`);
  const filiais = config.filiais;

  if (opcoes.has("--sondar-ressinc")) {
    // comSessao ja fecha o navegador dela sozinha (ver o comentario na funcao).
    await comSessao(filiais[0], sondarRessinc);
    diga("=== sondagem terminada ===");
    process.exit(0);
  }

  if (opcoes.has("--sondar-espiao")) {
    await comSessao(filiais[0], sondarEspiao);
    diga("=== sondagem terminada ===");
    process.exit(0);
  }

  if (!opcoes.has("--so-colher")) {
    // Uma filial que nao sincroniza NAO pode derrubar o ciclo.
    //
    // Era o que acontecia: em 28/10/2026 as 11:27 o 4XML respondeu "I/O
    // error" ao abrir a sincronizacao da Forest, o erro subiu, e o ciclo
    // morreu ali - sem colher nada. A colheita e a parte que leva nota ao
    // portal, e ela nao depende de a sincronizacao ter dado certo: le o que
    // ja esta no 4XML. Perder as duas por causa de uma e perder o dia.
    const sincronizadas = [];
    for (const filial of filiais) {
      try {
        const ok = await comSessao(filial, async (page) => {
          // Os Parametros da tela de NF-e abrem na frente; confirmar para
          // chegar na grade, que e de onde as Acoes ficam acessiveis.
          await page.getByRole("button", { name: "OK" }).first().click({ timeout: 20000 });
          await esperarProcessamento(page, 5);
          return sincronizar(page, filial);
        });
        if (ok) sincronizadas.push(filial.nome);
      } catch (err) {
        diga(`  filial ${filial.nome}: a sincronizacao falhou - ${String(err?.message || err)}`);
        diga("  o ciclo segue: a colheita le o que ja esta no 4XML e independe disto");
      }
    }
    if (sincronizadas.length < filiais.length) {
      diga(`ATENCAO: ${sincronizadas.length} de ${filiais.length} filiais confirmaram a ressincronizacao.`
        + " O que vier do Protheus pode estar desatualizado.");
    }

    // Nao ha mais espera cega aqui.
    //
    // Ate 27/10/2026 o robo disparava e esperava um numero fixo de minutos,
    // porque "Sincronizar Pendentes" nao mostra nada na tela e nao avisa
    // quando acaba. Com o Ressincronizar o 4XML mostra o progresso e para -
    // no video do fiscal, 26 segundos - entao cada filial ja volta pronta
    // de sincronizar().
  }

  if (!opcoes.has("--so-sincronizar")) {
    // A janela padrao e o mes corrente (DIAS existe so para teste pela linha
    // de comando). O "Puxar notas" do portal pode mandar um periodo proprio
    // em COLHER_DE/COLHER_ATE - e assim que o Eliabe alcanca uma nota de um
    // dia que o mes corrente nao pega; cada ponta em branco fica no padrao.
    const padraoDe = process.env.DIAS ? dataBr(Number(process.env.DIAS)) : primeiroDiaDoMes();
    const { de: inicio, ate: fim, escolhido } = resolverPeriodo({
      colherDe: process.env.COLHER_DE, colherAte: process.env.COLHER_ATE,
      padraoDe, padraoAte: dataBr(0),
    });

    // Colheita POR FILIAL. O X de nota cancelada (icone cexcannf) so aparece na
    // sessao da PROPRIA filial: visto de outra, a nota do grupo vira o icone
    // preto e o cancelamento some. Por isso a colheita antiga, so na primeira
    // filial, nunca via o cancelamento das outras - a nota da 02 entrava como
    // autorizada e a tela a chamava de "pendente" (medido em 05/11/2026, notas
    // 21684 e 10273735 da Onze, confirmadas canceladas na sessao da 02).
    //
    // A PRIMEIRA filial colhe "Todas Empresas" e anota os valores: uma sessao
    // ja traz todas as notas. As DEMAIS entram so para ver o cancelamento que a
    // primeira nao enxerga, e mandam valor zero - o upsert do portal nunca deixa
    // o zero apagar o valor que ja existe (ver grade4xml.js). Custa uma rolagem
    // de grade por filial extra, sem reler valor (a parte lenta).
    for (let i = 0; i < filiais.length; i += 1) {
      const filial = filiais[i];
      const principal = i === 0;
      await comSessao(filial, async (page) => {
        diga(principal ? "colhendo as notas" : `colhendo o cancelamento da filial ${filial.nome}`);
        if (escolhido) diga(`  periodo escolhido no portal: ${inicio} a ${fim}`);
        await filtrarPeriodo(page, inicio, fim);
        const linhas = await colherGrade(page);
        if (!linhas.length) { diga("  nenhuma nota no periodo"); return; }

        if (!principal) {
          // So o cancelamento: nao rele valor nenhum (o portal ja tem).
          await enviarAoPortal(linhas, {});
          return;
        }

        const guardar = [...opcoes].find((o) => o.startsWith("--salvar="));
        if (guardar) {
          const arquivo = guardar.slice("--salvar=".length);
          writeFileSync(arquivo, JSON.stringify(linhas, null, 1));
          diga("linhas salvas em", arquivo);
        }
        // Pergunta ao portal de quais notas ele JA sabe o valor, para nao
        // gastar um segundo de tela relendo cada uma delas.
        // --reler-valores: lê de novo o valor de TODAS as notas, inclusive as
        // que o portal já tem. É o conserto de quando um valor entrou errado -
        // aconteceu em 30/10/2026, com um atalho que gravava na nota seguinte
        // o total da anterior. Custa cerca de um segundo por nota, então não é
        // para o dia a dia: é para rodar uma vez e acertar a base.
        const jaTem = !opcoes.has("--reler-valores")
          ? await valoresJaConhecidos(linhas) : new Set();
        const valores = await valoresDaGrade(page, linhas, jaTem);
        await enviarAoPortal(linhas, valores);
      });
    }
  }
  diga("=== ciclo terminado ===");
} catch (err) {
  diga("ERRO:", String(err?.message || err));
  process.exitCode = 1;
}
// Nao ha mais um navegador global para fechar aqui: desde 11/11/2026 cada
// comSessao() sobe e derruba o seu proprio Chromium (ver o comentario la).
