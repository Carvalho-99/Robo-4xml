# Robô do 4XML

Faz, sozinho, o que o fiscal fazia a mão duas vezes por dia: sincroniza o
Espião XML do 4XML com a SEFAZ e manda para o portal a lista de NF-e modelo
55 que os fornecedores emitiram contra os CNPJs do grupo.

Quem manda nele é o portal, na aba **Robô**. Quem trabalha é um agente
instalado no computador de quem roda — porque o 4XML só existe na tela do
Protheus, e a tela precisa de uma sessão de Windows de verdade.

## Por que na máquina dele, e não no servidor

O 4XML é uma customização dentro do Protheus. Não tem API, e as tabelas dele
não estão no dicionário — conferido em 22/10/2026: a SX2 não lista nenhuma
tabela do 4XML, e a SX3 não conhece nem a coluna "Dt. Conf. Portaria" que
aparece na tela. A SDS/SDT (importação de XML padrão da TOTVS) está vazia.
Ou seja: o `genericQuery` que o portal já usa para a SF1 **não alcança** esses
dados. O único lugar onde eles existem é a tela.

## O que ele faz, na ordem

1. Abre o Protheus no navegador (sem janela), escolhe a filial no login e
   entra no módulo Compras.
2. Menu → Gerenciador 4XML → Acessar NF-e.
3. **Para cada filial** (Forest Paper e Onze), nesta ordem — conferida na
   tela em 22/10/2026:
   - Ações → **Espião XML** abre a janela de *filtros* (mês, ano, dias, CNPJ)
   - **Ok** abre a **grade do Espião** — e não a sincronização
   - **"Sincronizar com SEFAZ"**, botão na lateral dessa grade (o rótulo dele
     está no `title`, não no `caption`)
   - **Ok** na janela que abre: "Sincronizar Pendentes" já vem marcado, que é
     a busca incremental e é o que se quer na rotina. "Ressincronizar" relê um
     período inteiro e serve para recuperar, não para rodar todo dia.

   É a parte lenta: até 17 minutos para as duas filiais, com um *504 Gateway
   Timeout* no meio que não interrompe nada — o robô fecha o aviso e continua
   esperando.
4. Volta à tela de NF-e, filtra o período (últimos 7 dias por padrão,
   "Todas Empresas", "Todos XML") e lê a grade inteira.
5. Percorre a grade de novo, linha a linha, anotando o **valor** de cada nota
   no quadro "Total XML" — a grade não tem coluna de valor, ele só aparece
   para a nota selecionada. São uns 0,9 s por nota.
6. Manda as linhas e os valores para `POST /api/nfe55/4xml` no portal.

Duas armadilhas na leitura do valor, medidas na tela em 22/10/2026 e tratadas
no código: o "Total XML" chega **depois** da linha (ler cedo entrega o valor
da nota anterior, e o erro passa despercebido porque o número é plausível), e
quando duas notas seguidas têm o mesmo valor não dá para distinguir "são
iguais" de "ainda não chegou" — nesse caso o robô espera mais e confere de
novo.

Ele **não baixa arquivo nenhum**. Lê a grade direto da memória da tela. Por
isso não depende do TOTVS WebAgent — que é justamente o que faz o botão
"Exp. Excel" do 4XML falhar quando o agente local não está instalado.

## Como as duas pontas se falam

O portal **nunca** liga para a máquina. É sempre o agente que pergunta, de 20
em 20 segundos: *tem serviço para mim?* Quando tem, ele roda o `robo.mjs` e
devolve o diário linha a linha, que é o que aparece ao vivo na aba Robô.

Por isso tudo funciona atrás do firewall da Forest: nenhuma porta aberta,
nenhum IP fixo, nenhuma VPN. E por isso "Executar agora" não é instantâneo —
o pedido entra numa fila e a máquina pega na próxima pergunta.

```
portal (Cloudflare)                  máquina de quem roda
  aba Robô  ──pedido──►  fila
                          ▲  POST /api/robo/ping      agente.mjs
                          └──────────────────────────  (invisível, começa
                             POST /api/robo/log         junto com o Windows)
                             POST /api/robo/concluir        │
                                                            ▼
                                                        robo.mjs → Protheus
```

## Instalação

Na aba **Robô** do portal, **Baixar instalador**. Sai um
`Instalar Robo do 4XML.bat`: a pessoa abre no computador que vai rodar o robô
e espera a mensagem de pronto. Não há nada para digitar.

O instalador leva dentro dele o endereço do portal, o token do agente e o
usuário de integração do Protheus, e por isso só sai para quem entra no portal
como **admin**. Cada download vale **48 horas** e até **5 instalações**.

Ele instala em `%LOCALAPPDATA%\Robo4XML` e não precisa de administrador do
Windows. Se o Node não existir na máquina, ele traz uma cópia para dentro da
própria pasta — instalar o Node "de verdade" pediria elevação, que é
exatamente a dor de cabeça que se quer evitar. O navegador é o Edge que já vem
no Windows.

Vale para **o computador e a conta** em que foi rodado: é nessa sessão que o
Protheus abre. A mesma pessoa em dois computadores são duas máquinas na lista,
e isso é proposital.

### O que fica na máquina

| arquivo | o que é |
|---|---|
| `senha.dat`, `token.dat` | senha do Protheus e token do portal, cifrados pelo DPAPI do Windows — só a mesma conta, na mesma máquina, lê |
| `maquina.json` | a identidade sorteada na instalação; é por ela que o portal reconhece este computador |
| `agente.vbs` | o atalho que roda o Node **sem janela** |
| `logs\` | o diário local, que fica mesmo quando o portal não recebe |

A tarefa agendada se chama **Robo 4XML**: entra junto com a pessoa e, se o
agente morrer, o traz de volta em até três minutos.

> Essa repetição é também a razão de o agente travar uma porta
> local (8421) ao subir. Quem a tarefa executa é o `wscript`, que sai no mesmo
> instante: para o Windows a tarefa sempre terminou, e o `IgnoreNew` nunca
> entra em ação. Sem a trava, uma máquina ligada o dia inteiro acumularia um
> agente a cada repetição — aconteceu, dois subiram em oito minutos.

### Atualização

O agente compara a versão dele com a do pacote publicado no portal a cada
pergunta. Diferente, ele baixa o pacote novo e sai; a tarefa agendada o traz
de volta já atualizado.

Isso existe por uma falha real: em 23/10/2026 uma máquina passou um dia com
uma versão antiga, esperando uma sincronização que aquela versão nem sabia
disparar, e não havia como perceber de longe.

Por isso **`VERSAO` em `robo.mjs` sobe a cada mudança**, inclusive duas no
mesmo dia. Se a versão não mudar, a atualização não acontece. Depois de mexer
no robô:

```powershell
npm run robo:pacote   # monta public/robo/pacote.zip e versao.json
npm run deploy        # publica o portal com o pacote dentro
```

O pacote não é público: `public/robo/` é barrado no worker e só sai por
`/api/robo/pacote.zip`, que confere convite ou token do agente.

## Comandando pelo portal

Na aba Robô, cada computador é um cartão:

- **Executar agora** — o ciclo completo (busca na SEFAZ, leitura da grade,
  carga no portal; uns 20 minutos). O diário abre junto e vai preenchendo.
- **Buscar sozinho** — os horários combinados, **no máximo 2 por dia**, em
  dias úteis ou todos, com data final opcional. O horário mora no portal, não
  no Windows: muda de onde a pessoa estiver.
- **Ver diário** — o log da última execução.
- **Remover** — tira o computador da lista. Se o agente continuar instalado
  lá, ele volta a aparecer: para tirar de vez, desinstale naquela máquina.

Quem decide se um horário venceu é o portal, no momento em que o agente
pergunta — não o relógio da máquina. A janela é de **2 horas**: um notebook
ligado às 15h não dispara a corrida das 08:00, que já não serviria para nada.

## Desligando

Na própria máquina, dentro de `%LOCALAPPDATA%\Robo4XML`:

```powershell
powershell -ExecutionPolicy Bypass -File desinstalar.ps1          # pausa
powershell -ExecutionPolicy Bypass -File desinstalar.ps1 -Tudo    # remove
```

Sem `-Tudo`: o agente sai do ar e para de entrar sozinho. A pasta, as
credenciais e os diários ficam — rodar o instalador de novo religa tudo.

Com `-Tudo`: apaga também as credenciais e a identidade. A pasta em si fica,
porque os diários moram nela.

Depois, remova o computador da lista pela aba Robô.

## Conferindo

```powershell
node robo.mjs --so-colher --seco --visivel   # mostra a janela, não grava nada
node robo.mjs --so-colher                    # colhe e manda ao portal
node robo.mjs --so-sincronizar               # só a sincronização com a SEFAZ
node robo.mjs                                # ciclo completo
```

`PORTAL_URL=http://127.0.0.1:8787` aponta para um portal local em teste, e
`PROTHEUS_USUARIO` / `PROTHEUS_SENHA` passam na frente do que está na máquina
— é assim que se testa uma conta nova sem reescrever nada.

Para conferir se um agente instalado está de pé, sem atrapalhar o que já
estiver rodando:

```powershell
node agente.mjs --uma-vez
```

O diário de cada dia fica em `logs/AAAA-MM-DD.log`, e todo erro grava também
uma foto da tela ao lado, que costuma explicar sozinha o que aconteceu.

## Ajustes em `config.json`

| campo | para que serve |
|---|---|
| `diasParaTras` | tamanho da janela que ele colhe (padrão 7 dias) |
| `minutosSincronizacao` | quanto espera a SEFAZ antes de desistir (padrão 25) |
| `maxValores` | teto de notas para ler o valor (padrão 400, ~0,9 s cada) |
| `janela` | `oculta` (padrão) ou `visivel`, se precisar acompanhar |
| `filiais` | código e nome de cada filial a sincronizar |
| `navegador` | caminho de um Chrome/Edge específico, se o automático errar |

## O status na grade

As quatro primeiras colunas são ícones, e o nome do arquivo diz o status.
Confirmado com o fiscal e conferido contra as 593 notas de 30/09 a 22/10/2026:

| ícone | o que é | conferência |
|---|---|---|
| `br_verde` | classificada, já lançada | 249 notas, **todas** com data de lançamento |
| `br_vermelho` | pendente de lançamento | 22 notas, **nenhuma** com data |
| `cexcannf` (o X) | **nota cancelada** | 10 notas |
| `br_preto` | nota de outra empresa do grupo | a sessão está noutra filial |

Só o cancelamento vira situação no portal, e nunca volta atrás. Lançada ou
pendente o portal descobre sozinho, confrontando a chave com a SF1 — isso é
mais confiável que a cor, porque olha o Protheus de verdade e não depende de
em qual filial o robô entrou.

## O que ele ainda não resolve

- **Valor como prova de divergência.** O robô lê o "Total XML" da tela, e não
  está confirmado que essa é a mesma base do `F1_VALBRUT` da SF1 — frete e IPI
  podem entrar num e não no outro. O valor aparece no painel, mas **não acusa
  divergência** até alguém conferir isso com o fiscal.
- **Se a máquina dormir no meio de um ciclo**, ele simplesmente para onde
  estava. Não há meio-caminho estragado: tudo é gravado por chave de acesso,
  então a execução seguinte refaz o que faltou. No portal a execução fica
  pendurada em "trabalhando" por 90 minutos e depois é encerrada como falha,
  para a fila daquela máquina não travar para sempre.
- **A sincronização com a SEFAZ está provada** desde 26/10/2026, e custou
  três tentativas até sair uma medição limpa. O que vale é a janela em que
  só o robô agiu: às 15:08 a grade tinha 226 registros e a colheita não
  achou nenhuma nota nova; às 21:48 o robô disparou a sincronização; às
  22:06 a grade tinha **240**, com 14 notas que o portal não conhecia.
  Ninguém abriu o 4XML nesse intervalo.

  As duas medições anteriores não serviram porque alguém rodou o Espião na
  mão dentro da mesma janela — o clique humano e o do robô ficavam
  indistinguíveis. **Para repetir a medição: ninguém pode tocar no 4XML
  entre a colheita que estabelece a base e a que mede o resultado.**
- **O filtro "Apenas NF-e Empresa" é gravado por usuário** e vinha como
  "Apenas Empresa" na conta nova — ou seja, a colheita traria só uma empresa.
  O robô conserta isso toda vez que filtra, em vez de só avisar. Se um dia o
  diário trouxer "não consegui deixar em Todas Empresas", **é para parar e
  olhar**: as notas da Forest ou da Onze vão faltar.
