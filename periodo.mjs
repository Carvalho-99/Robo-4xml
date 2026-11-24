// O período que a colheita vai filtrar na grade do 4XML ("Emissão de/até").
//
// Vive num arquivo próprio por um motivo só: robo.mjs abre o navegador assim
// que é importado, então não dá para carregá-lo num teste. Esta conta é pura
// e sem relógio, então aqui ela pode ser exercitada de verdade, em vez de só
// lida no código-fonte.

// ISO "AAAA-MM-DD" -> "DD/MM/AAAA" (o formato do campo de data do Protheus),
// ou "" quando não é uma data ISO. O que não for data vira padrão lá em cima.
export function brDeIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

// O Eliabe pode escolher o período no "Puxar notas" do portal (colherDe e
// colherAte chegam em ISO pelo ambiente). Cada ponta em branco cai no padrão
// que o chamador passou — a janela do mês corrente. A saída é sempre em
// DD/MM/AAAA, pronta para digitar no filtro.
export function resolverPeriodo({ colherDe, colherAte, padraoDe, padraoAte }) {
  const de = brDeIso(colherDe) || padraoDe;
  const ate = brDeIso(colherAte) || padraoAte;
  return { de, ate, escolhido: Boolean(brDeIso(colherDe) || brDeIso(colherAte)) };
}
