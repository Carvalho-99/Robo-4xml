# Robô do 4XML

Automação que desenvolvi para eliminar uma conferência manual que um fiscal
fazia, à mão, duas vezes por dia: sincronizar o módulo **4XML** (gestão de
NF-e) com a **SEFAZ** dentro do Protheus e repassar a lista de notas modelo
55 recebidas dos fornecedores para o
[portal de recebimento de notas](https://portal-recebimento-notas.tiforest.workers.dev)
— outro projeto meu, feito em Cloudflare Workers, que cruza essas notas com
o fiscal já lançado no ERP.

## O problema

O 4XML é uma customização dentro do Protheus, sem API e sem tabelas no
dicionário de dados do ERP — confirmei isso olhando a SX2/SX3 do sistema: a
SX2 não lista nenhuma tabela do módulo, e a SX3 nem conhece as colunas que
aparecem na tela. Os dados **só existem na tela mesmo**, renderizados por um
componente Protheus (`po-page`) que não expõe nada para automação
convencional via banco ou REST.

Ou seja: a única forma de ler esses dados de forma confiável é automatizar a
própria tela — e foi esse o desafio que me propus a resolver.

## A solução

Um agente Node.js instalado no computador de quem já tem uma sessão Windows
logada no Protheus. De 20 em 20 segundos ele pergunta ao portal se há
serviço pendente; quando há, dispara um ciclo que:

1. Abre o Protheus num navegador headless (Playwright) e entra no módulo
   Compras → Gerenciador 4XML.
2. Para cada filial, aciona "Espião XML" → "Sincronizar com SEFAZ" (rotina
   que pode levar até 17 minutos e emite um *504 Gateway Timeout* no meio
   sem necessariamente falhar — o robô reconhece isso e continua esperando
   em vez de abortar).
3. Lê a grade de notas inteira, linha a linha, inclusive o valor de cada
   nota — que só aparece para a linha selecionada no momento, então o robô
   precisa esperar o valor certo "chegar" antes de anotar (ler cedo demais
   captura o valor da nota anterior) e tratar o caso de duas notas seguidas
   com o mesmo valor, onde não dá para saber se é coincidência ou se o valor
   ainda não atualizou.
4. Envia o resultado normalizado para o portal via HTTPS.

## Decisões de arquitetura

- **Nenhuma porta aberta, nenhum IP fixo, nenhuma VPN.** O portal nunca liga
  para a máquina — é sempre o agente que pergunta. Isso deixa o robô
  funcionar atrás de qualquer firewall corporativo sem exigir nada da rede.
- **Credenciais nunca em texto puro.** Senha do ERP e token do portal ficam
  cifrados pelo DPAPI do Windows, atados à conta e à máquina que instalou —
  nem o próprio robô consegue lê-los em outro computador.
- **Autoatualização versionada.** O agente compara sua versão com a do
  pacote publicado no portal a cada pergunta; se mudou, baixa e reinicia já
  atualizado. Existe por causa de um incidente real: uma máquina passou um
  dia inteiro rodando uma versão antiga, esperando por uma sincronização que
  aquela versão nem sabia disparar.
- **Supervisão via Tarefa Agendada do Windows**, que recoloca o agente no ar
  em até três minutos se ele cair — com uma trava por porta local para não
  duplicar instâncias a cada reinício.

```
portal (Cloudflare Workers)          computador de quem roda
  aba Robô  ──pedido──►  fila
                          ▲  POST /api/robo/ping      agente.mjs
                          └──────────────────────────  (em segundo plano,
                             POST /api/robo/log         inicia com o Windows)
                             POST /api/robo/concluir        │
                                                            ▼
                                                        robo.mjs → Protheus
```

## Stack

Node.js · Playwright (automação de navegador) · Cloudflare Workers + D1 (o
portal que recebe os dados) · DPAPI do Windows para credenciais · Tarefa
Agendada do Windows para resiliência.

## Resultado

Validei a sincronização comparando a grade antes e depois de uma janela em
que ninguém tocou no 4XML: às 15h08 a grade tinha 226 registros e a
colheita não achou nota nova; às 21h48 o robô disparou a sincronização; às
22h06 a grade já tinha 240, com 14 notas que o portal ainda não conhecia.
Conferindo 593 notas de um mês de operação, o status captado pelo robô bateu
100% com o que existia de fato no Protheus.

## Estrutura

| arquivo | o que é |
|---|---|
| `agente.mjs` | processo de fundo que consulta o portal a cada 20s |
| `robo.mjs` | o ciclo completo de automação do Protheus |
| `periodo.mjs` | utilitário de datas/janela de sincronização |
| `segredos.mjs` | leitura das credenciais cifradas por DPAPI |
| `config.json` | filiais, janela de dias, tempos de espera (valores de exemplo neste repositório) |
| `empacotar.ps1` / `desinstalar.ps1` | empacotamento e remoção do agente |
| `anterior/` | uma primeira versão do painel local, com um avatar 3D de login — ideia que abandonei ao migrar o controle inteiro para o portal web |

Documentação completa de instalação, operação e as armadilhas que encontrei
pelo caminho: **[LEIAME.md](LEIAME.md)**.

> Este repositório é uma versão de portfólio: os valores em `config.json`
> (endereço do servidor e usuário) foram trocados por exemplos — o robô, na
> prática, roda contra a instalação real da empresa onde o desenvolvi.
