# Comparação de amplitude do robô

Mesma posição de cursor, duas configurações. Abra os pares lado a lado.

| arquivo | o que é |
|---|---|
| `antes-*.png` | limites iniciais: cabeça yaw 1° / pitch 1,5°, pescoço yaw 2° / pitch 0,5° |
| `depois-*.png` | limites aplicados: cabeça yaw 19° / pitch 10°, pescoço yaw 9° / pitch 5° |

Deslocamento do rosto de uma borda da janela à outra:

| | antes | depois |
|---|---|---|
| horizontal | 15,1 px | **137,5 px** |
| vertical | 10,6 px | **79,5 px** |

Os limites vieram de renderizar o modelo em leque e olhar a junção da cabeça
com o pescoço ângulo por ângulo: o yaw composto fica limpo até uns 34° e o
pitch até -28° (para baixo) e +16° (para cima). O que está aplicado — 28° de
yaw e 15° de pitch somados — fica abaixo disso nos dois sentidos.

---

# Correção da gola (23/10/2026)

**Sintoma:** ao virar, a junção do pescoço com o peito se quebrava — frestas
brancas atravessando o mecanismo escuro e pedaços da borda branca da gola se
separando.

**Diagnóstico.** Pintando cada malha de uma cor (`diagnostico-grupos-por-cor.png`),
ficou claro que a gola larga que se apoia no peito estava dentro de
`Geo_Neck` — a mesma malha do pescoço. Girando **só** `CTRL_Neck`, ela
girava junto e se partia contra o tronco. Girando **só** `CTRL_Head`, a
junção ficava perfeita: o defeito era inteiro do pescoço.

**Por que o primeiro corte não resolveu.** Tentei separar por altura, e não
funcionou: gola e pescoço ocupam a mesma faixa de Y. O que distingue os dois
é a **distância do eixo** — a coluna do pescoço é estreita, a gola se abre
sobre o peito. O corte passou a ser por raio (0,075), com um piso de altura
para a aba de baixo.

**Resultado.** Compare `gola-ANTES-pescoco-25graus.png` com
`gola-DEPOIS-pescoco-25graus.png`: mesmo ângulo, 25° só no pescoço — quase
três vezes o que a tela usa. Antes, cacos brancos soltos dos dois lados.
Depois, a coluna gira dentro da gola e a gola não sai do lugar.

A correção é feita ao carregar o modelo, em `entrar.html`: os triângulos da
gola passam para `CTRL_Torso` compartilhando os mesmos atributos de
geometria, então UV, normais, material e textura seguem idênticos aos do
arquivo. O `.glb` não foi alterado — há uma cópia intacta em
`modelo/robot_login_prepared.ORIGINAL.glb`.

---

# Troca do personagem (23/10/2026)

O personagem passou a ser o do componente `robot-hero` que o Bruno escolheu,
portado para JavaScript puro em `robo-cena.js`. O modelo GLB e a tela que o
usava estão guardados em `anterior/entrar-modelo-glb.html` e
`modelo/robot_login_prepared.glb`.

`movimento-1.png` a `movimento-6.png` são seis quadros do cursor varrendo a
tela da esquerda para a direita, alternando altura. Abra em sequência: dá para
ver o corpo deslizar e inclinar e a cabeça girar bem mais que o corpo.

O que veio do componente, sem alteração de valores: geometrias e medidas,
texturas procedurais de ruído, o shader de fresnel da tela da cabeça, o
desenho dos olhos em tubo, a piscada, os corações no clique, as orelhas com
antena e toda a matemática de movimento.

O que precisou de equivalente, porque vinha do Drei:

| Drei | aqui |
|---|---|
| `Environment preset="studio"` | `RoomEnvironment` + `PMREMGenerator` |
| `ContactShadows` | câmera ortográfica por baixo gravando profundidade, borrada em duas passadas |
