# Painel local — aposentado em 23/10/2026

Até aqui, quem mandava no robô era este painel, que subia em
`127.0.0.1:8420` na máquina do fiscal. Quem não estivesse naquele
computador não via nem o horário combinado nem o que tinha acontecido.

Desde 23/10/2026 quem manda é o portal, na aba **Robô**, e a máquina só
obedece — ver `agente.mjs`. O painel não é mais instalado e as rotas
`/api/painel/*` do portal foram removidas junto.

O que está guardado aqui:

- `painel.mjs`, `painel.html` — o servidor local e a tela.
- `entrar.html`, `robo-cena.js`, `vendor/`, `modelo/` — a tela de entrada com
  o robô 3D que seguia o cursor. Nada disso tem substituto no portal: se um
  dia a cena for reaproveitada, é daqui que ela sai.
- `calibrar.html` — a folha de contato que serviu para achar o defeito da
  gola do personagem.
- `instalar.ps1`, `guardar-senha.ps1` — a instalação feita à mão, com senha
  digitada. Hoje quem instala é o `.bat` que se baixa no portal.

Nada disso roda. Está aqui porque foi trabalho feito e pode ser útil de
novo, não porque faz parte do robô.
