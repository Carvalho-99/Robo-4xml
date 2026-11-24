// O personagem da tela de entrada.
//
// É a transcrição para JavaScript puro do componente React `robot-hero` que
// o Bruno escolheu como referência: mesmas geometrias, mesmas medidas, mesmos
// materiais, mesmo shader de vidro e mesma matemática de movimento. O que era
// JSX virou `THREE.Group`; o que era `useFrame` virou uma volta de
// `requestAnimationFrame`; o que eram refs virou variável.
//
// Dois recursos vinham do Drei e foram refeitos com o que o Three.js traz:
//
//   Environment preset="studio"  ->  RoomEnvironment + PMREMGenerator
//   ContactShadows               ->  câmera ortográfica por baixo renderizando
//                                    profundidade, borrada em duas passadas
//
// A versão com o modelo GLB está guardada em anterior/entrar-modelo-glb.html.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HorizontalBlurShader } from "three/addons/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/addons/shaders/VerticalBlurShader.js";

// ---------- ajustes, com os nomes e valores do componente ----------

const DESENHO = {
  corChassi: "#c4c4c4",
  corTela: "#00ffc6",
  grossuraTela: 3.8,
  brilhoTela: 1.2,
  separacaoOlhos: 0.07,
  tamanhoOrelhas: 1.3,
  escalaOlhos: 1.1,
  piscadaCiclo: 3.0,
  piscadaDuracao: 0.45,
  alturaCabeca: 0.6,
  metalness: 0.0,
};

const MOVIMENTO = {
  velocidadeDeslocamento: 0.35,
  velocidadeGiroCorpo: 10.0,
  velocidadeGiroCabeca: 20.0,
  inclinacaoCorpoY: 0.95,
  olharCabecaX: 0.3,
  olharCabecaY: 1.8,
};

const PESCOCO = {
  baseR: 0.215, baseH: -0.05, midR: 0.28, midH: 0.02,
  lipBottomR: 0.295, lipBottomH: 0.045, lipTopR: 0.27, lipTopH: 0.055,
  innerR: 0.1, innerDropH: 0.0,
};
const CORPO = { bevelR: 0.235, bevelY: 0.34, bevelT: 0.025 };

const AMBIENTE = {
  luzAmbiente: 0.75,
  sombraOpacidade: 0.85,
  sombraBorrao: 1.7,
  sombraEscala: 6.0,     // area da mancha no chao, em unidades do mundo
  sombraAltura: -0.79,
  sombraLonge: 2.5,
};

// A demonstracao do componente ocupa a tela inteira; aqui ele divide espaco
// com o formulario. A escala do personagem e a mesma que o componente atinge
// numa tela larga (1,1); quem enquadra e a camera, mais perto.
// A escala 1,1 e o teto a que o proprio componente chega numa tela larga; o
// 0,88 e o recuo de 12% pedido. Como a sombra e filha deste mesmo grupo, ela
// encolhe junto e continua do tamanho certo sob o personagem.
const ENQUADRAMENTO = { escala: 1.1 * 0.88, distanciaCamera: 3.9, alturaCamera: 0.16 };

// ---------- texturas procedurais ----------

// Ruído de pontinhos escuros, o mesmo do componente: dá granulação à carcaça
// clara sem precisar de arquivo de textura.
function texturasDoChassi() {
  const lado = 512;
  const telaCor = document.createElement("canvas");
  const telaRelevo = document.createElement("canvas");
  telaCor.width = telaCor.height = telaRelevo.width = telaRelevo.height = lado;
  const cor = telaCor.getContext("2d");
  const relevo = telaRelevo.getContext("2d");

  cor.fillStyle = "#dcdcdc";
  cor.fillRect(0, 0, lado, lado);
  relevo.fillStyle = "#808080";
  relevo.fillRect(0, 0, lado, lado);

  for (let i = 0; i < 10000; i += 1) {
    const x = Math.random() * lado;
    const y = Math.random() * lado;
    const r = 0.5 + Math.random() * 1.5;
    const escuro = Math.random() > 0.15;
    cor.beginPath(); cor.arc(x, y, r, 0, Math.PI * 2);
    cor.fillStyle = escuro ? "#222222" : "#dddddd";
    cor.fill();
    relevo.beginPath(); relevo.arc(x, y, r, 0, Math.PI * 2);
    relevo.fillStyle = escuro ? "#000000" : "#ffffff";
    relevo.fill();
  }

  const mapaCor = new THREE.CanvasTexture(telaCor);
  const mapaRelevo = new THREE.CanvasTexture(telaRelevo);
  for (const t of [mapaCor, mapaRelevo]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(6, 3);
    t.needsUpdate = true;
  }
  mapaCor.colorSpace = THREE.SRGBColorSpace;
  return { mapaCor, mapaRelevo };
}

// ---------- peças ----------

function materialChassi({ mapaCor, mapaRelevo }) {
  return new THREE.MeshStandardMaterial({
    color: DESENHO.corChassi,
    map: mapaCor,
    bumpMap: mapaRelevo,
    bumpScale: 0.005,
    roughness: 1.0,
    metalness: DESENHO.metalness,
    envMapIntensity: 0.0,
  });
}

// A "tela" da cabeça: uma casca que só acende nas bordas (fresnel), somando
// luz em vez de cobrir. É o que dá o contorno turquesa.
function capsulaDeVidro() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(DESENHO.corTela) },
      power: { value: DESENHO.grossuraTela },
      intensity: { value: DESENHO.brilhoTela },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPosition;
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float power;
      uniform float intensity;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float fresnel = 1.0 - max(dot(viewDir, normal), 0.0);
        fresnel = pow(fresnel, power);
        gl_FragColor = vec4(color, fresnel * intensity);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(0.3, 64, 64, 0, Math.PI * 2, 0, Math.PI), material);
}

const matOrelhaBase = new THREE.MeshStandardMaterial({ color: "#f0f0f0", roughness: 0.5 });
const matOrelhaAnel = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.3 });
const matOrelhaCentro = new THREE.MeshStandardMaterial({ color: "#cccccc", roughness: 0.8 });
const matAntenaBase = new THREE.MeshStandardMaterial({ color: "#999999", roughness: 0.4, metalness: 0.5 });
const matAntenaHaste = new THREE.MeshStandardMaterial({ color: "#d0d0d0", roughness: 0.4, metalness: 0.2 });
const matAntenaPonta = new THREE.MeshStandardMaterial({ color: "#ff3366", roughness: 0.2, toneMapped: false });

function orelha(posicao, escala, esquerda) {
  const g = new THREE.Group();
  g.position.set(...posicao);
  g.scale.setScalar(escala);
  const lado = esquerda ? -1 : 1;

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.025, 32), matOrelhaBase);
  base.rotation.z = Math.PI / 2;
  g.add(base);

  const anel = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.008, 16, 32), matOrelhaAnel);
  anel.position.x = lado * 0.012;
  anel.rotation.z = Math.PI / 2;
  g.add(anel);

  const centro = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.005, 32), matOrelhaCentro);
  centro.position.x = lado * 0.012;
  centro.rotation.z = Math.PI / 2;
  g.add(centro);

  const antena = new THREE.Group();
  antena.position.set(lado * 0.015, 0.035, 0);
  antena.rotation.x = -0.4;
  const pe = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.02, 16), matAntenaBase);
  pe.position.y = 0.01;
  const haste = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.1, 8), matAntenaHaste);
  haste.position.y = 0.06;
  const ponta = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 16), matAntenaPonta);
  ponta.position.y = 0.11;
  antena.add(pe, haste, ponta);
  g.add(antena);

  for (const m of [base, anel, centro, pe, haste, ponta]) { m.castShadow = true; m.receiveShadow = true; }
  return g;
}

// Olho: dois traços (pálpebra de cima e de baixo) feitos de tubo, e um
// coração que aparece no lugar deles quando se clica no robô.
const matOlho = new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 2, 2), toneMapped: false, transparent: true });
const matCoracao = new THREE.MeshBasicMaterial({ color: "#ff3366", toneMapped: false });

class CurvaCoracao extends THREE.Curve {
  getPoint(t, destino = new THREE.Vector3()) {
    t = t * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return destino.set(x * 0.002, (y + 6) * 0.002, 0);
  }
}
const curvaCoracao = new CurvaCoracao();

function caminhosDoOlho() {
  const w = 0.025, h = 0.035, r = 0.02, g = 0.005;
  const V = (x, y) => new THREE.Vector3(x, y, 0);
  const cima = new THREE.CurvePath();
  cima.add(new THREE.LineCurve3(V(-w, g), V(-w, h - r)));
  cima.add(new THREE.QuadraticBezierCurve3(V(-w, h - r), V(-w, h), V(-w + r, h)));
  cima.add(new THREE.LineCurve3(V(-w + r, h), V(w - r, h)));
  cima.add(new THREE.QuadraticBezierCurve3(V(w - r, h), V(w, h), V(w, h - r)));
  cima.add(new THREE.LineCurve3(V(w, h - r), V(w, g)));
  const baixo = new THREE.CurvePath();
  baixo.add(new THREE.LineCurve3(V(-w, -g), V(-w, -(h - r))));
  baixo.add(new THREE.QuadraticBezierCurve3(V(-w, -(h - r)), V(-w, -h), V(-w + r, -h)));
  baixo.add(new THREE.LineCurve3(V(-w + r, -h), V(w - r, -h)));
  baixo.add(new THREE.QuadraticBezierCurve3(V(w - r, -h), V(w, -h), V(w, -(h - r))));
  baixo.add(new THREE.LineCurve3(V(w, -(h - r)), V(w, -g)));
  return { cima, baixo };
}

function olho(posicao, giroY, escala) {
  const g = new THREE.Group();
  g.position.set(...posicao);
  g.rotation.y = giroY;
  g.scale.setScalar(escala);

  const coracao = new THREE.Mesh(new THREE.TubeGeometry(curvaCoracao, 64, 0.0035, 8, true), matCoracao);
  coracao.visible = false;

  const normais = new THREE.Group();
  const { cima, baixo } = caminhosDoOlho();
  normais.add(new THREE.Mesh(new THREE.TubeGeometry(cima, 20, 0.0035, 8, false), matOlho));
  normais.add(new THREE.Mesh(new THREE.TubeGeometry(baixo, 20, 0.0035, 8, false), matOlho));

  g.add(coracao, normais);
  return { grupo: g, coracao, normais, escala };
}

// ---------- sombra de contato ----------
//
// O Drei entrega isto pronto. Aqui é feito à mão, do jeito que o próprio
// Three.js demonstra: uma câmera ortográfica olha o personagem de baixo para
// cima gravando só profundidade, e o resultado passa por dois borrões antes
// de virar a mancha no chão. Sem isso o personagem fica flutuando.
function sombraDeContato(render, cena) {
  const tamanho = AMBIENTE.sombraEscala;
  const resolucao = 512;
  const grupo = new THREE.Group();
  grupo.position.y = AMBIENTE.sombraAltura;

  const alvo = new THREE.WebGLRenderTarget(resolucao, resolucao);
  alvo.texture.generateMipmaps = false;
  const alvoBorrao = new THREE.WebGLRenderTarget(resolucao, resolucao);
  alvoBorrao.texture.generateMipmaps = false;

  const chao = new THREE.Mesh(
    new THREE.PlaneGeometry(tamanho, tamanho),
    new THREE.MeshBasicMaterial({
      map: alvo.texture, opacity: AMBIENTE.sombraOpacidade,
      transparent: true, depthWrite: false,
    }),
  );
  chao.rotation.x = -Math.PI / 2;
  chao.renderOrder = 1;
  grupo.add(chao);

  const camera = new THREE.OrthographicCamera(-tamanho / 2, tamanho / 2, tamanho / 2, -tamanho / 2, 0, AMBIENTE.sombraLonge);
  camera.rotation.x = Math.PI / 2;
  grupo.add(camera);

  const profundidade = new THREE.MeshDepthMaterial();
  profundidade.userData.darkness = { value: 1.0 };
  profundidade.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = profundidade.userData.darkness;
    shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader}`
      .replace("gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
        "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );");
  };
  profundidade.depthTest = false;
  profundidade.depthWrite = false;

  const planoBorrao = new THREE.Mesh(new THREE.PlaneGeometry(), null);
  planoBorrao.visible = false;
  const camBorrao = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const matH = new THREE.ShaderMaterial(HorizontalBlurShader);
  const matV = new THREE.ShaderMaterial(VerticalBlurShader);
  matH.depthTest = matV.depthTest = false;

  function borrar(quanto) {
    planoBorrao.visible = true;
    planoBorrao.material = matH;
    matH.uniforms.tDiffuse.value = alvo.texture;
    matH.uniforms.h.value = (quanto * 1) / 256;
    render.setRenderTarget(alvoBorrao);
    render.render(planoBorrao, camBorrao);
    planoBorrao.material = matV;
    matV.uniforms.tDiffuse.value = alvoBorrao.texture;
    matV.uniforms.v.value = (quanto * 1) / 256;
    render.setRenderTarget(alvo);
    render.render(planoBorrao, camBorrao);
    planoBorrao.visible = false;
  }

  function desenhar() {
    const corAntiga = render.getClearColor(new THREE.Color());
    const alfaAntigo = render.getClearAlpha();
    const fundoAntigo = cena.background;
    cena.background = null;
    cena.overrideMaterial = profundidade;
    render.setClearColor(0x000000, 0);
    render.setRenderTarget(alvo);
    render.clear();
    render.render(cena, camera);
    cena.overrideMaterial = null;
    borrar(AMBIENTE.sombraBorrao);
    borrar(AMBIENTE.sombraBorrao * 0.4);
    render.setRenderTarget(null);
    render.setClearColor(corAntiga, alfaAntigo);
    cena.background = fundoAntigo;
  }

  return { grupo, desenhar, chao };
}

// ---------- montagem ----------

export function montarRobo(area) {
  const render = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  render.setClearAlpha(0);
  render.outputColorSpace = THREE.SRGBColorSpace;
  area.appendChild(render.domElement);

  const cena = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, ENQUADRAMENTO.alturaCamera, ENQUADRAMENTO.distanciaCamera);

  cena.add(new THREE.AmbientLight(0xffffff, AMBIENTE.luzAmbiente));

  // Equivalente ao Environment do Drei: uma sala de estúdio gerada em código,
  // convertida em mapa de reflexo. É o que dá brilho às orelhas e antenas.
  const pmrem = new THREE.PMREMGenerator(render);
  cena.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const texturas = texturasDoChassi();
  const matChassi = materialChassi(texturas);

  // O componente envolve tudo num grupo que se redimensiona com a janela.
  const grupoResponsivo = new THREE.Group();
  cena.add(grupoResponsivo);

  const corpo = new THREE.Group();
  corpo.position.y = -0.3;
  grupoResponsivo.add(corpo);

  const casco = new THREE.Mesh(
    new THREE.SphereGeometry(0.43, 64, 64, 0, Math.PI * 2, Math.PI * 0.15, Math.PI * 0.85), matChassi);
  casco.castShadow = casco.receiveShadow = true;
  corpo.add(casco);

  const friso = new THREE.Mesh(new THREE.TorusGeometry(CORPO.bevelR, CORPO.bevelT, 32, 64), matChassi);
  friso.position.y = CORPO.bevelY;
  friso.rotation.x = Math.PI / 2;
  friso.castShadow = friso.receiveShadow = true;
  corpo.add(friso);

  const perfil = [
    new THREE.Vector2(PESCOCO.innerR, PESCOCO.baseH),
    new THREE.Vector2(PESCOCO.baseR, PESCOCO.baseH),
    new THREE.Vector2(PESCOCO.midR, PESCOCO.midH),
    new THREE.Vector2(PESCOCO.lipBottomR, PESCOCO.lipBottomH),
    new THREE.Vector2(PESCOCO.lipTopR, PESCOCO.lipTopH),
    new THREE.Vector2(PESCOCO.innerR, PESCOCO.lipTopH),
    new THREE.Vector2(PESCOCO.innerR, PESCOCO.lipTopH - PESCOCO.innerDropH),
  ];
  const gola = new THREE.Mesh(new THREE.LatheGeometry(perfil, 64), matChassi);
  gola.position.y = 0.38;
  gola.castShadow = gola.receiveShadow = true;
  corpo.add(gola);

  const cabeca = new THREE.Group();
  cabeca.position.y = DESENHO.alturaCabeca;
  corpo.add(cabeca);

  const calota = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 64, 64, 0, Math.PI * 2, 0, Math.PI),
    new THREE.MeshStandardMaterial({ color: "#111111", roughness: 1.0, metalness: 0.0 }));
  calota.castShadow = calota.receiveShadow = true;
  cabeca.add(calota, capsulaDeVidro());

  const parOlhos = new THREE.Group();
  parOlhos.position.set(0, -0.02, 0.29);
  const olhoE = olho([-DESENHO.separacaoOlhos, 0, 0], -0.2, DESENHO.escalaOlhos);
  const olhoD = olho([DESENHO.separacaoOlhos, 0, 0], 0.2, DESENHO.escalaOlhos);
  parOlhos.add(olhoE.grupo, olhoD.grupo);
  cabeca.add(parOlhos);

  cabeca.add(orelha([-0.29, 0, 0], DESENHO.tamanhoOrelhas, true));
  cabeca.add(orelha([0.29, 0, 0], DESENHO.tamanhoOrelhas, false));

  const sombra = sombraDeContato(render, cena);
  grupoResponsivo.add(sombra.grupo);

  // ---------- movimento ----------

  const ponteiro = new THREE.Vector2(0, 0);
  let apaixonado = false, relogioPaixao = 0;
  const lerp = THREE.MathUtils.lerp;

  function medir() {
    const r = area.getBoundingClientRect();
    if (!r.width || !r.height) return;
    render.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    render.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    // O mesmo cálculo do ResponsiveGroup: a largura visível em unidades do
    // mundo, à distância da câmera.
    const altura = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.position.z;
    larguraVisivel = altura * camera.aspect;
    grupoResponsivo.scale.setScalar(ENQUADRAMENTO.escala);
  }
  let larguraVisivel = 3.5;

  function quadro(dt, tempo) {
    const passo = Math.min(dt, 0.1);
    const tx = ponteiro.x;
    const ty = ponteiro.y;

    const maxDeslocamento = larguraVisivel / 3.5;
    corpo.position.x = lerp(corpo.position.x, tx * maxDeslocamento, MOVIMENTO.velocidadeDeslocamento * passo);

    const relativo = tx - corpo.position.x / 2.5;
    corpo.rotation.y = lerp(corpo.rotation.y, -relativo * MOVIMENTO.inclinacaoCorpoY, MOVIMENTO.velocidadeGiroCorpo * passo);
    corpo.rotation.x = lerp(corpo.rotation.x, -ty * 0.25, MOVIMENTO.velocidadeGiroCorpo * passo);
    corpo.rotation.z = lerp(corpo.rotation.z, -relativo * 0.15, MOVIMENTO.velocidadeGiroCorpo * passo);

    cabeca.rotation.y = lerp(cabeca.rotation.y, relativo * MOVIMENTO.olharCabecaY, MOVIMENTO.velocidadeGiroCabeca * passo);
    cabeca.rotation.x = lerp(cabeca.rotation.x, -ty * MOVIMENTO.olharCabecaX, MOVIMENTO.velocidadeGiroCabeca * passo);

    // Piscada: o olho encolhe na vertical por um instante a cada ciclo.
    if (apaixonado && tempo > relogioPaixao) apaixonado = false;
    const ciclo = tempo % DESENHO.piscadaCiclo;
    let fator = 1;
    if (ciclo < DESENHO.piscadaDuracao && !apaixonado) {
      fator = Math.max(0.05, 1 - Math.sin((ciclo / DESENHO.piscadaDuracao) * Math.PI));
    }
    for (const o of [olhoE, olhoD]) {
      o.normais.visible = !apaixonado;
      o.coracao.visible = apaixonado;
      o.grupo.scale.set(o.escala, o.escala * fator, o.escala);
    }
  }

  // ---------- laço ----------

  let laco = null, ultimo = performance.now();
  function girar(agora) {
    const dt = (agora - ultimo) / 1000;
    ultimo = agora;
    quadro(dt, agora / 1000);
    sombra.desenhar();
    render.render(cena, camera);
    laco = requestAnimationFrame(girar);
  }

  return {
    medir,
    ligar() { if (!laco) { ultimo = performance.now(); laco = requestAnimationFrame(girar); } },
    desligar() { if (laco) { cancelAnimationFrame(laco); laco = null; } },
    // Um quadro só, para quem pediu menos movimento.
    parado() { quadro(0, 0); sombra.desenhar(); render.render(cena, camera); },
    mirar(x, y) { ponteiro.set(x, y); },
    apaixonar(tempo) { apaixonado = true; relogioPaixao = tempo + 2; },
    // Para a validação: o estado real do que está na tela.
    estado: () => ({
      corpo: { x: corpo.position.x, giroY: corpo.rotation.y, giroX: corpo.rotation.x, giroZ: corpo.rotation.z },
      cabeca: { giroY: cabeca.rotation.y, giroX: cabeca.rotation.x },
      olhoEscalaY: olhoE.grupo.scale.y / olhoE.escala,
      coracao: olhoE.coracao.visible,
    }),
    area: () => render.domElement,
  };
}
