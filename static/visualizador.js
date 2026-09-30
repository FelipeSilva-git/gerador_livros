"use strict";

// "Ver livro pronto": o livro em 3D, na ordem da história, com as páginas virando.
// - Toque/clique na página da direita avança; na da esquerda volta (ou use os botões).
// - Arrastar gira o livro; roda do mouse, pinça ou ➕/➖ dão zoom.
// Cada folha 3D tem frente (página ímpar, à direita) e verso (página par, à esquerda).
// Livro de páginas deitadas e dobrado abre para cima (como calendário): as folhas viram
// em volta da borda de cima, frente embaixo e verso em cima.

const vis = {
  janela: $("#visualizador"),
  abertas: 0,   // quantas folhas já foram viradas
  total: 0,     // folhas 3D
  paginas: 0,   // páginas do livro (completando com brancas, como no impresso)
  zoom: 1,
  rx: 18,       // inclinação para frente
  ry: 0,        // giro para os lados
};

const VISTA_INICIAL = { zoom: 1, rx: 18, ry: 0 };

function abrirVisualizador() {
  const { paginas, ajuste, margem_mm, numerar } = livroAtual;
  if (!paginas.length) return alert("Coloque imagens no livro primeiro.");
  const g = geometria();
  vis.paginas = montarFolhas(paginas.length, livroAtual.modo).totalComBrancos; // como no impresso
  vis.total = vis.paginas / 2;
  vis.eixo = g.dobrada && g.deitada ? "x" : "y";
  vis.aspecto = g.pagL / g.pagA;
  vis.abertas = 0;
  Object.assign(vis, VISTA_INICIAL);

  const face = (num, lado) => {
    const p = paginas[num - 1];
    const f = el("div", { class: `vis-face ${lado} ${ajuste}` });
    f.style.setProperty("--margem-pct", `${(margem_mm / g.pagL) * 100}%`);
    if (p && !p.vazia) f.append(el("img", { src: imagemUrl(p.img_id), alt: `Página ${num}`, draggable: "false" }));
    if (numerar) f.append(el("span", { class: "vis-num" }, String(num)));
    f.dataset.lado = lado;
    return f;
  };

  const livro = el("div", { class: `vis-livro eixo-${vis.eixo}` });
  for (let i = 0; i < vis.total; i++) {
    livro.append(el("div", { class: "vis-folha", "data-i": i },
      face(2 * i + 1, "frente"), face(2 * i + 2, "verso")));
  }
  const palco = el("div", { class: "vis-palco" }, livro);
  const indicador = el("b", { class: "vis-indicador" });

  vis.janela.replaceChildren(
    el("div", { class: "vis-topo" },
      el("h2", {}, "📖 ", livroAtual.nome),
      indicador,
      botao("✖️", "Fechar", "Fechar a visualização", () => vis.janela.close())),
    palco,
    el("div", { class: "vis-controles" },
      botao("◀️", "Voltar", "Voltar uma página", () => virar(-1), "grande vis-voltar"),
      botao("➖", "", "Afastar", () => mudarZoom(-0.15)),
      botao("🎯", "Endireitar", "Voltar o livro para a posição normal", endireitar),
      botao("➕", "", "Aproximar", () => mudarZoom(0.15)),
      botao("▶️", "Avançar", "Avançar uma página", () => virar(1), "primario grande vis-avancar")),
    el("p", { class: "dica vis-dica" }, "Toque na página para folhear. Arraste para girar o livro. Use ➕ e ➖ para aproximar."));

  vis.livro = livro;
  vis.palco = palco;
  vis.indicador = indicador;
  ligarGestos(palco);
  vis.janela.showModal();
  medir();
  atualizar(false);
}

// Tamanho da página conforme o espaço da tela e a proporção da página do livro
function medir() {
  const { width, height } = vis.palco.getBoundingClientRect();
  let largura, altura;
  if (vis.eixo === "y") { // páginas lado a lado
    largura = Math.max(60, Math.min(width * 0.44, height * 0.78 * vis.aspecto));
    altura = largura / vis.aspecto;
  } else {                // páginas uma em cima da outra
    altura = Math.max(40, Math.min(height * 0.4, (width * 0.8) / vis.aspecto));
    largura = altura * vis.aspecto;
  }
  vis.livro.style.setProperty("--pw", `${largura}px`);
  vis.livro.style.setProperty("--ph", `${altura}px`);
  vis.largura = largura;
  vis.altura = altura;
}

function atualizar(animar = true) {
  const { abertas, total, livro } = vis;
  // Folhas empilhadas: as não viradas à direita (a próxima por cima), as viradas à esquerda
  livro.querySelectorAll(".vis-folha").forEach((f) => {
    const i = Number(f.dataset.i);
    const virada = i < abertas;
    const altura = virada ? i + 1 : total - i;
    const giro = vis.eixo === "y" ? `rotateY(${virada ? -180 : 0}deg)` : `rotateX(${virada ? 180 : 0}deg)`;
    f.style.transform = `translateZ(${altura * 0.6}px) ${giro}`;
    f.classList.toggle("virada", virada);
  });
  // Livro fechado fica centralizado: capa (só um lado) ou contracapa (só o outro)
  const metade = vis.eixo === "y" ? vis.largura / 2 : vis.altura / 2;
  const deslocar = abertas === 0 ? -metade : abertas === total ? metade : 0;
  livro.classList.toggle("sem-animacao", !animar);
  livro.style.transform = `scale(${vis.zoom}) rotateX(${vis.rx}deg) rotateY(${vis.ry}deg) ` +
    (vis.eixo === "y" ? `translateX(${deslocar}px)` : `translateY(${deslocar}px)`);

  vis.indicador.textContent =
    abertas === 0 ? "Capa (página 1)" :
    abertas === total ? `Contracapa (página ${vis.paginas})` :
    `Páginas ${2 * abertas} e ${2 * abertas + 1} de ${vis.paginas}`;
  vis.janela.querySelector(".vis-voltar").disabled = abertas === 0;
  vis.janela.querySelector(".vis-avancar").disabled = abertas === total;
}

function virar(passo) {
  const novo = Math.min(vis.total, Math.max(0, vis.abertas + passo));
  if (novo === vis.abertas) return;
  vis.abertas = novo;
  atualizar();
}

function mudarZoom(delta) {
  vis.zoom = Math.min(3, Math.max(0.5, vis.zoom + delta));
  atualizar();
}

function endireitar() {
  Object.assign(vis, VISTA_INICIAL);
  atualizar();
}

function ligarGestos(palco) {
  const toques = new Map();
  let inicio = null;   // { x, y, rx, ry, arrastou }
  let pinca = null;    // { dist, zoom }
  const distancia = () => {
    const [a, b] = [...toques.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  palco.addEventListener("pointerdown", (e) => {
    toques.set(e.pointerId, { x: e.clientX, y: e.clientY });
    palco.setPointerCapture(e.pointerId);
    if (toques.size === 1) inicio = { x: e.clientX, y: e.clientY, rx: vis.rx, ry: vis.ry, arrastou: false, alvo: e.target };
    if (toques.size === 2) { pinca = { dist: distancia(), zoom: vis.zoom }; if (inicio) inicio.arrastou = true; }
  });

  palco.addEventListener("pointermove", (e) => {
    if (!toques.has(e.pointerId)) return;
    toques.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinca && toques.size === 2) {
      vis.zoom = Math.min(3, Math.max(0.5, pinca.zoom * (distancia() / pinca.dist)));
      atualizar(false);
      return;
    }
    if (!inicio) return;
    const dx = e.clientX - inicio.x, dy = e.clientY - inicio.y;
    if (!inicio.arrastou && Math.hypot(dx, dy) < 8) return;
    inicio.arrastou = true;
    vis.ry = inicio.ry + dx * 0.4;
    vis.rx = Math.min(75, Math.max(-75, inicio.rx - dy * 0.4));
    atualizar(false);
  });

  const soltar = (e) => {
    toques.delete(e.pointerId);
    if (toques.size < 2) pinca = null;
    if (toques.size === 0 && inicio) {
      // Toque sem arrastar: folheia (direita avança, esquerda volta)
      if (!inicio.arrastou) {
        const faceTocada = inicio.alvo.closest?.(".vis-face");
        if (faceTocada) virar(faceTocada.dataset.lado === "frente" ? 1 : -1);
        else {
          const r = palco.getBoundingClientRect();
          const depois = vis.eixo === "y" ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
          virar(depois ? 1 : -1);
        }
      }
      inicio = null;
    }
  };
  palco.addEventListener("pointerup", soltar);
  palco.addEventListener("pointercancel", soltar);

  palco.addEventListener("wheel", (e) => {
    e.preventDefault();
    mudarZoom(e.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });
}

vis.janela.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") virar(1);
  else if (e.key === "ArrowLeft") virar(-1);
  else if (e.key === "+" || e.key === "=") mudarZoom(0.15);
  else if (e.key === "-") mudarZoom(-0.15);
  else return;
  e.preventDefault();
});
window.addEventListener("resize", () => {
  if (vis.janela.open) { medir(); atualizar(false); }
});
vis.janela.addEventListener("close", () => vis.janela.replaceChildren());

$("#btn-ver-livro").addEventListener("click", abrirVisualizador);
