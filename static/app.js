"use strict";

// Os dados são lidos e gravados pelo "armazem" (armazem.js): servidor no PC, banco interno no celular.

const $ = (sel) => document.querySelector(sel);

// Botão grande com ícone e texto (sempre visíveis)
function botao(icone, texto, dica, aoClicar, classe = "") {
  return el("button", {
    class: `btn ${classe}`, title: dica,
    onclick: (e) => { e.stopPropagation(); aoClicar(); },
  }, el("span", { class: "icone" }, icone), texto);
}

function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const f of filhos) if (f != null) e.append(f);
  return e;
}

// ---------- Papel, orientação e montagem ----------
const PAPEIS = {
  A4: { nome: "A4", larg: 210, alt: 297 },
  A5: { nome: "A5", larg: 148, alt: 210 },
  A3: { nome: "A3", larg: 297, alt: 420 },
  carta: { nome: "Carta", larg: 215.9, alt: 279.4 },
  oficio: { nome: "Ofício", larg: 216, alt: 330 },
  legal: { nome: "Legal", larg: 215.9, alt: 355.6 },
};
const MONTAGENS = { livreto: "livreto grampeado", empilhado: "folhas dobradas e coladas", soltas: "folhas soltas" };
const mm = (n) => String(Math.round(n));
const paginasPorFolha = (modo) => (modo === "soltas" ? 2 : 4);

// Tamanho da folha e das páginas conforme o papel, a orientação e a montagem.
// Folha dobrada com páginas em pé: folha deitada, páginas lado a lado (dobra vertical).
// Folha dobrada com páginas deitadas: folha em pé, páginas uma em cima da outra
// (dobra horizontal; o livro abre para cima, como um calendário).
// Folhas soltas: uma página por lado, a folha fica como a página.
function geometria(livro = livroAtual) {
  const curto = Math.min(livro.papel_larg, livro.papel_alt);
  const longo = Math.max(livro.papel_larg, livro.papel_alt);
  const deitada = livro.orientacao === "paisagem";
  const dobrada = livro.modo !== "soltas";
  const g = {
    curto, longo, deitada, dobrada,
    nomePapel: livro.papel === "personalizado" ? `${mm(curto)} × ${mm(longo)} mm` : (PAPEIS[livro.papel] || PAPEIS.A4).nome,
  };
  if (dobrada && !deitada) Object.assign(g, { folhaL: longo, folhaA: curto, pagL: longo / 2, pagA: curto, arranjo: "lado-a-lado" });
  else if (dobrada) Object.assign(g, { folhaL: curto, folhaA: longo, pagL: curto, pagA: longo / 2, arranjo: "empilhada" });
  else if (!deitada) Object.assign(g, { folhaL: curto, folhaA: longo, pagL: curto, pagA: longo, arranjo: "unica" });
  else Object.assign(g, { folhaL: longo, folhaA: curto, pagL: longo, pagA: curto, arranjo: "unica" });
  g.folhaDeitada = g.folhaL > g.folhaA;
  // Frente e verso automático: livro dobrado vira na borda curta; folha solta em pé, na borda longa
  g.virar = dobrada || deitada ? "curta" : "longa";
  return g;
}
const tamanhoDaFolha = () => { const g = geometria(); return { larg: g.folhaL, alt: g.folhaA }; };

// ---------- Montagem das folhas (imposição) ----------
// Folha dobrada: 4 páginas, frente = [1ª metade, 2ª metade] e verso = [1ª metade, 2ª metade]
// (metades = esquerda/direita, ou em cima/embaixo quando as páginas são deitadas).
// Folha solta: frente = [página], verso = [página seguinte].
// Números de página começam em 1; páginas que faltam ficam em branco.
function montarFolhas(totalPaginas, modo) {
  if (modo === "soltas") {
    const n = Math.max(2, Math.ceil(totalPaginas / 2) * 2);
    const folhas = [];
    for (let i = 0; i < n / 2; i++) folhas.push({ frente: [2 * i + 1], verso: [2 * i + 2] });
    return { folhas, totalComBrancos: n };
  }
  const n = Math.max(4, Math.ceil(totalPaginas / 4) * 4);
  const folhas = [];
  for (let i = 0; i < n / 4; i++) {
    if (modo === "empilhado") {
      // Folha dobrada sozinha: capa = 4i+1, miolo = 4i+2 e 4i+3, contracapa = 4i+4.
      folhas.push({ frente: [4 * i + 4, 4 * i + 1], verso: [4 * i + 2, 4 * i + 3] });
    } else {
      // Livreto: folhas encaixadas, a de fora leva a primeira e a última página.
      folhas.push({ frente: [n - 2 * i, 2 * i + 1], verso: [2 * i + 2, n - 2 * i - 1] });
    }
  }
  return { folhas, totalComBrancos: n };
}

// ---------- Estado ----------
let livroAtual = null;

// ---------- Rotas ----------
async function roteador() {
  const m = location.hash.match(/^#\/livro\/(\d+)/);
  $("#tela-livros").hidden = !!m;
  $("#tela-livro").hidden = !m;
  try {
    if (m) await abrirLivro(Number(m[1]));
    else await mostrarLivros();
  } catch (e) {
    alert(e.message);
    location.hash = "#/";
  }
}
window.addEventListener("hashchange", roteador);

// ---------- Tela: lista de livros ----------
async function mostrarLivros() {
  livroAtual = null;
  document.title = "Livrinhos de Colorir";
  const livros = await armazem.listarLivros();
  const lista = $("#lista-livros");
  lista.replaceChildren();
  $("#sem-livros").hidden = livros.length > 0;
  for (const l of livros) {
    const capa = l.capa_img
      ? el("img", { src: imagemUrl(l.capa_img), alt: "" })
      : document.createTextNode("sem páginas");
    const folhas = l.total_paginas ? Math.ceil(l.total_paginas / paginasPorFolha(l.modo)) : 0;
    lista.append(
      el("a", { class: "livro-cartao", href: `#/livro/${l.id}` },
        el("div", { class: "capa" }, capa),
        el("div", { class: "info" },
          el("b", {}, l.nome),
          el("span", {}, `${l.total_paginas} página(s) · ${folhas} folha(s)`)))
    );
  }
}

$("#btn-novo-livro").addEventListener("click", async () => {
  const nome = prompt("Nome do livro:");
  if (nome === null) return;
  const livro = await armazem.criarLivro(nome);
  location.hash = `#/livro/${livro.id}`;
});

// ---------- Tela: um livro ----------
async function abrirLivro(id) {
  const outroLivro = livroAtual?.id !== id;
  livroAtual = await armazem.obterLivro(id);
  // Livro novo, sem páginas: começa mostrando o formato para escolher
  if (outroLivro) $("#etapa-formato").open = !livroAtual.paginas.length;
  renderizarLivro();
}

function renderizarLivro() {
  const l = livroAtual;
  document.title = `${l.nome} · Livrinhos de Colorir`;
  $("#nome-livro").value = l.nome;
  for (const campo of ["modo", "ajuste", "orientacao", "papel"]) {
    const r = document.querySelector(`input[name=${campo}][value="${l[campo]}"]`);
    if (r) r.checked = true;
  }
  $("#margem").value = l.margem_mm;
  $("#numerar").checked = !!l.numerar;
  atualizarFormato();
  renderizarPaginas();
  renderizarPrevia();
}

// Resumos e dicas que dependem do papel, da orientação e da montagem
function atualizarFormato() {
  const l = livroAtual;
  const g = geometria();
  const total = l.paginas.length;
  const folhas = total ? Math.ceil(total / paginasPorFolha(l.modo)) : 0;

  $("#tela-livro").style.setProperty("--pag-aspect", `${g.pagL} / ${g.pagA}`);
  $("#papel-personalizado").hidden = l.papel !== "personalizado";
  $("#papel-larg").value = mm(g.curto);
  $("#papel-alt").value = mm(g.longo);

  $("#resumo-formato").textContent =
    `${g.nomePapel} · páginas ${g.deitada ? "deitadas" : "em pé"} · ${MONTAGENS[l.modo]}`;
  $("#resultado-formato").replaceChildren(
    "✅ Cada página terá ", el("b", {}, `${mm(g.pagL)} × ${mm(g.pagA)} mm`), ". ",
    g.dobrada
      ? `Cada folha ${g.nomePapel} leva 4 páginas (2 na frente e 2 no verso) e é dobrada ao meio` +
        (g.deitada ? " na horizontal: o livro abre para cima, como um calendário." : ".")
      : `Cada folha ${g.nomePapel} leva 2 páginas (1 na frente e 1 no verso), sem dobrar.`);

  $("#info-paginas").textContent = total ? `${total} página(s) · ${folhas} folha(s)` : "nenhuma página ainda";
  $("#resumo-impressao").textContent = total
    ? `${total} página(s) → ${folhas} folha(s) ${g.nomePapel}, frente e verso`
    : "Coloque as páginas na etapa 2.";
  $("#dica-janela").replaceChildren(
    "Na janela de impressão, escolha: papel ", el("b", {}, g.nomePapel), ", ",
    el("b", {}, g.folhaDeitada ? "Paisagem" : "Retrato"), ", ",
    el("b", {}, "Margens: nenhuma"), " e ", el("b", {}, "Escala 100%"), ".");
  $("#dica-duplex").replaceChildren("Escolha ", el("b", {}, `Frente e verso: virar na borda ${g.virar}`), ".");
}

function renderizarPaginas() {
  const paginas = livroAtual.paginas;
  const lista = $("#lista-paginas");
  lista.replaceChildren();
  for (const id of ["#btn-imprimir", "#btn-frentes", "#btn-versos"]) $(id).disabled = paginas.length === 0;

  // Onde cada página vai sair: número da página -> "Folha 2 · Verso"
  const onde = {};
  if (paginas.length) {
    montarFolhas(paginas.length, livroAtual.modo).folhas.forEach((f, i) => {
      for (const n of f.frente) onde[n] = `Folha ${i + 1} · Frente`;
      for (const n of f.verso) onde[n] = `Folha ${i + 1} · Verso`;
    });
  }

  paginas.forEach((p, i) => {
    const marca = i === 0 ? "▶ Início" : i === paginas.length - 1 ? "Fim ■" : null;
    const item = el("li", { class: "pagina", draggable: "true", "data-id": p.id, title: p.nome },
      el("span", { class: "num" }, String(i + 1)),
      marca && el("span", { class: "marca" }, marca),
      p.vazia
        ? el("div", { class: "miniatura-branca" }, "página em branco")
        : el("img", { src: imagemUrl(p.img_id), alt: p.nome, loading: "lazy" }),
      el("div", { class: "acoes" },
        botao("⬅️", "", "Passar esta página para antes", () => mover(i, i - 1)),
        botao("➡️", "", "Passar esta página para depois", () => mover(i, i + 1))),
      el("div", { class: "acoes coluna" },
        p.vazia
          ? botao("➕", "Colocar imagem", "Colocar uma imagem nesta página", () => escolherArquivo((arq) => trocarImagem(p, arq)))
          : botao("🔄", "Trocar", "Trocar a imagem desta página", () => escolherArquivo((arq) => trocarImagem(p, arq))),
        p.vazia
          ? botao("✖️", "Remover", "Tirar esta página do livro", () => removerPagina(p), "perigo")
          : botao("🗑️", "Apagar", "Apagar a imagem (a página fica em branco)", () => apagarImagem(p), "perigo"),
        !p.vazia && botao("🖨️", "Imprimir", "Imprimir só esta página", () => escolherImpressaoUnica(i + 1), "imprimir-uma")),
      el("div", { class: "onde", title: "Onde esta página vai ser impressa no livro" }, "📍 ", onde[i + 1]));
    ligarArrastarPagina(item);
    lista.append(item);
  });
}

// Arrastar para reordenar
let idArrastado = null;
function ligarArrastarPagina(item) {
  item.addEventListener("dragstart", (e) => {
    idArrastado = Number(item.dataset.id);
    item.classList.add("arrastando");
    e.dataTransfer.effectAllowed = "move";
  });
  item.addEventListener("dragend", () => {
    idArrastado = null;
    item.classList.remove("arrastando");
    document.querySelectorAll(".pagina.alvo").forEach((x) => x.classList.remove("alvo"));
  });
  item.addEventListener("dragover", (e) => {
    if (idArrastado === null && !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    item.classList.add("alvo");
  });
  item.addEventListener("dragleave", () => item.classList.remove("alvo"));
  item.addEventListener("drop", (e) => {
    if (idArrastado === null && e.dataTransfer.files.length) {
      // Imagem do computador solta em cima da página: troca a imagem dela
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove("alvo");
      const pagina = livroAtual.paginas.find((p) => p.id === Number(item.dataset.id));
      trocarImagem(pagina, e.dataTransfer.files[0]);
      return;
    }
    if (idArrastado === null) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = livroAtual.paginas.map((p) => p.id);
    mover(ids.indexOf(idArrastado), ids.indexOf(Number(item.dataset.id)));
  });
}

async function mover(de, para) {
  const paginas = [...livroAtual.paginas];
  if (para < 0 || para >= paginas.length || de === para) return;
  const [p] = paginas.splice(de, 1);
  paginas.splice(para, 0, p);
  livroAtual.paginas = paginas;
  renderizarPaginas();
  renderizarPrevia();
  livroAtual = await armazem.reordenar(livroAtual.id, paginas.map((x) => x.id));
}

// Apaga só a imagem: a página fica em branco e nenhuma outra muda de lugar
async function apagarImagem(p) {
  const num = livroAtual.paginas.indexOf(p) + 1;
  if (!confirm(`Apagar a imagem da página ${num}? A página fica em branco e as outras não mudam de lugar.`)) return;
  await armazem.apagarImagem(p.id);
  await abrirLivro(livroAtual.id);
}

// Tira a página do livro (as seguintes sobem uma posição)
async function removerPagina(p) {
  const num = livroAtual.paginas.indexOf(p) + 1;
  const ultima = num === livroAtual.paginas.length;
  const aviso = ultima ? "" : " Atenção: as páginas depois dela vão voltar uma posição.";
  if (!confirm(`Remover a página ${num} do livro?${aviso}`)) return;
  await armazem.removerPagina(p.id);
  await abrirLivro(livroAtual.id);
}

// Trocar a imagem de uma página (mantém a posição)
function escolherArquivo(aoEscolher) {
  const entrada = el("input", { type: "file", accept: "image/*" });
  entrada.addEventListener("change", () => {
    if (entrada.files[0]) aoEscolher(entrada.files[0]);
  });
  entrada.click();
}

// Coloca a imagem exatamente na página "num". Se a página ainda não existe,
// cria páginas em branco até chegar nela.
async function colocarNaPosicao(num, arquivo) {
  const pagina = livroAtual.paginas[num - 1];
  if (pagina) return trocarImagem(pagina, arquivo);
  if (!arquivo.type.startsWith("image/")) return alert("Escolha um arquivo de imagem.");
  const faltam = num - 1 - livroAtual.paginas.length;
  for (let i = 0; i < faltam; i++) await criarPaginaVazia();
  await enviarArquivos([arquivo]);
}

function criarPaginaVazia() {
  return armazem.adicionarPagina(livroAtual.id, null);
}

$("#btn-pagina-branca").addEventListener("click", async () => {
  await criarPaginaVazia();
  await abrirLivro(livroAtual.id);
});

async function trocarImagem(pagina, arquivo) {
  if (!arquivo.type.startsWith("image/")) return alert("Escolha um arquivo de imagem.");
  const num = livroAtual.paginas.indexOf(pagina) + 1;
  const status = $("#status-envio");
  status.hidden = false;
  status.textContent = `Trocando a imagem da página ${num}…`;
  try {
    await armazem.trocarImagem(pagina.id, arquivo);
    status.hidden = true;
  } catch (e) {
    status.textContent = `Erro ao trocar: ${e.message}`;
  }
  await abrirLivro(livroAtual.id);
}

// Envio de imagens
async function enviarArquivos(arquivos) {
  const imagens = [...arquivos]
    .filter((f) => f.type.startsWith("image/"))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
  if (!imagens.length) return;
  const status = $("#status-envio");
  status.hidden = false;
  try {
    for (const [i, arq] of imagens.entries()) {
      status.textContent = `Enviando ${i + 1} de ${imagens.length}: ${arq.name}…`;
      await armazem.adicionarPagina(livroAtual.id, arq);
    }
    status.hidden = true;
  } catch (e) {
    status.textContent = `Erro ao enviar: ${e.message}`;
  }
  await abrirLivro(livroAtual.id);
}

const zona = $("#zona-envio");
$("#entrada-arquivos").addEventListener("change", (e) => {
  enviarArquivos(e.target.files);
  e.target.value = "";
});
for (const ev of ["dragenter", "dragover"]) {
  zona.addEventListener(ev, (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    zona.classList.add("arrastando");
  });
}
zona.addEventListener("dragleave", () => zona.classList.remove("arrastando"));
zona.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  zona.classList.remove("arrastando");
  enviarArquivos(e.dataTransfer.files);
});
// Soltar imagens em qualquer lugar da tela do livro também funciona
document.addEventListener("dragover", (e) => {
  if (livroAtual && e.dataTransfer.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!livroAtual || !e.dataTransfer.files.length) return;
  e.preventDefault();
  enviarArquivos(e.dataTransfer.files);
});

// Configurações do livro
async function salvar(campos) {
  livroAtual = await armazem.atualizarLivro(livroAtual.id, campos);
  renderizarLivro(); // o formato muda onde e como cada página sai
}
$("#nome-livro").addEventListener("change", (e) => salvar({ nome: e.target.value }));
for (const campo of ["modo", "ajuste", "orientacao"]) {
  document.querySelectorAll(`input[name=${campo}]`).forEach((r) =>
    r.addEventListener("change", () => salvar({ [campo]: r.value })));
}
document.querySelectorAll("input[name=papel]").forEach((r) => r.addEventListener("change", async () => {
  if (r.value !== "personalizado") {
    return salvar({ papel: r.value, papel_larg: PAPEIS[r.value].larg, papel_alt: PAPEIS[r.value].alt });
  }
  await salvar({ papel: "personalizado" }); // começa com a medida atual; depois é só digitar
  $("#papel-larg").focus();
}));
for (const id of ["#papel-larg", "#papel-alt"]) {
  $(id).addEventListener("change", () => salvar({
    papel: "personalizado", papel_larg: Number($("#papel-larg").value), papel_alt: Number($("#papel-alt").value),
  }));
}
$("#margem").addEventListener("change", (e) => salvar({ margem_mm: Number(e.target.value) || 0 }));
$("#numerar").addEventListener("change", (e) => salvar({ numerar: e.target.checked }));

$("#btn-excluir-livro").addEventListener("click", async () => {
  if (!confirm(`Excluir o livro "${livroAtual.nome}" e todas as páginas? Não dá para desfazer.`)) return;
  await armazem.excluirLivro(livroAtual.id);
  location.hash = "#/";
});

// ---------- Desenho das folhas ----------
// interativo = prévia na tela (aceita clique e imagens soltas); falso = impressão
function criarLado(numeros, interativo) {
  const { paginas, ajuste, margem_mm } = livroAtual;
  const g = geometria();
  const folha = el("div", { class: `folha ${ajuste} ${g.arranjo}` });
  folha.style.setProperty("--fl", g.folhaL);
  folha.style.setProperty("--fa", g.folhaA);
  // margem em % da largura da folha (padding em % é sempre relativo à largura)
  folha.style.setProperty("--margem-pct", `${(margem_mm / g.folhaL) * 100}%`);
  for (const num of numeros) {
    const pagina = num ? paginas[num - 1] : null; // num nulo = metade vazia (impressão de uma página)
    const temImagem = pagina && !pagina.vazia;
    const metade = el("div", { class: temImagem ? "metade" : "metade branco" });
    if (temImagem) metade.append(el("img", { src: imagemUrl(pagina.img_id), alt: "" }));
    if (interativo) ligarMetade(metade, num, pagina, temImagem);
    else if (livroAtual.numerar && num) metade.append(el("span", { class: "numero-impresso" }, String(num)));
    folha.append(metade);
  }
  return folha;
}

function ligarMetade(metade, num, pagina, temImagem) {
  metade.classList.add("interativa");
  metade.title = temImagem
    ? `Clique ou solte uma imagem aqui para trocar a página ${num}`
    : `Clique ou solte uma imagem aqui para colocar na página ${num}`;
  if (!temImagem) metade.append(el("span", { class: "convite" }, el("span", { class: "icone" }, "➕"), "Página em branco"));
  metade.append(el("span", { class: "rotulo" }, `Pág. ${num}`));
  metade.addEventListener("click", () => escolherArquivo((arq) => colocarNaPosicao(num, arq)));
  metade.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    metade.classList.add("alvo");
  });
  metade.addEventListener("dragleave", () => metade.classList.remove("alvo"));
  metade.addEventListener("drop", (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    metade.classList.remove("alvo");
    colocarNaPosicao(num, e.dataTransfer.files[0]);
  });
}

function renderizarPrevia() {
  const previa = $("#previa-folhas");
  previa.replaceChildren();
  const total = livroAtual.paginas.length;
  const aviso = $("#aviso-branco");
  if (!total) {
    aviso.hidden = true;
    previa.append(el("p", { class: "dica" }, "Adicione imagens para ver as folhas."));
    return;
  }
  const { folhas, totalComBrancos } = montarFolhas(total, livroAtual.modo);
  const brancos = totalComBrancos - total;
  aviso.hidden = brancos === 0;
  aviso.textContent = `Cada folha tem ${paginasPorFolha(livroAtual.modo)} páginas. ` +
    `Com ${total} página(s), ${brancos} página(s) no final vão ficar em branco. ` +
    `Adicione mais ${brancos} imagem(ns) para completar.`;
  const g = geometria();
  const nomeLado = (nums) => nums.length === 1 ? `página ${nums[0]}`
    : g.arranjo === "empilhada" ? `página ${nums[0]} em cima e ${nums[1]} embaixo`
    : `páginas ${nums.join(" e ")}`;

  folhas.forEach((f, i) => {
    previa.append(
      el("div", { class: "previa-folha" },
        el("div", { class: "cabecalho-folha" },
          el("h3", {}, `Folha ${i + 1}`),
          botao("🖨️", "Imprimir a folha (frente e verso)", `Imprimir só a folha ${i + 1}, frente e verso`,
            () => mandarImprimir([criarLado(f.frente, false), criarLado(f.verso, false)]))),
        el("div", { class: "previa-lados" },
          ladoPrevia(`Frente: ${nomeLado(f.frente)}`, f.frente),
          ladoPrevia(`Verso: ${nomeLado(f.verso)}`, f.verso))));
  });
}

function ladoPrevia(titulo, numeros) {
  return el("figure", {},
    el("figcaption", {},
      el("span", {}, titulo),
      botao("🖨️", "Imprimir este lado", `Imprimir só este lado (${titulo.toLowerCase()})`,
        () => mandarImprimir([criarLado(numeros, false)]))),
    criarLado(numeros, true),
    el("div", { class: `barra-lado lados-${numeros.length}` }, ...numeros.map(botoesDaMetade)));
}

function botoesDaMetade(num) {
  const pagina = livroAtual.paginas[num - 1];
  const grupo = el("div", { class: "grupo" }, el("b", { class: "grupo-rotulo" }, `Pág. ${num}`));
  if (pagina && !pagina.vazia) {
    grupo.append(
      botao("🔄", "Trocar", `Trocar a imagem da página ${num}`,
        () => escolherArquivo((arq) => colocarNaPosicao(num, arq))),
      botao("🗑️", "Apagar", `Apagar a imagem da página ${num} (fica em branco)`,
        () => apagarImagem(pagina), "perigo"));
  } else {
    grupo.append(botao("➕", "Colocar imagem", `Colocar uma imagem na página ${num}`,
      () => escolherArquivo((arq) => colocarNaPosicao(num, arq)), "primario"));
  }
  return grupo;
}

// ---------- Impressão ----------
async function imprimir(quais) {
  if (!livroAtual.paginas.length) return;
  const { folhas } = montarFolhas(livroAtual.paginas.length, livroAtual.modo);
  const lados = [];
  if (quais === "tudo") folhas.forEach((f) => lados.push(f.frente, f.verso));
  if (quais === "frentes") folhas.forEach((f) => lados.push(f.frente));
  if (quais === "versos") {
    folhas.forEach((f) => lados.push(f.verso));
    if ($("#inverter-versos").checked) lados.reverse();
  }

  await mandarImprimir(lados.map((numeros) => criarLado(numeros, false)));
}

// Coloca as folhas na área de impressão e abre a impressão (PC ou Android)
// tamanho = papel como sai da impressora, em mm (padrão: a folha do livro)
async function mandarImprimir(folhas, tamanho = tamanhoDaFolha()) {
  const area = $("#impressao");
  area.replaceChildren(...folhas);
  $("#estilo-pagina").textContent = `@page { size: ${tamanho.larg}mm ${tamanho.alt}mm; margin: 0; }`;

  // Espera todas as imagens carregarem antes de abrir a janela de impressão
  await Promise.all([...area.querySelectorAll("img")].map((img) =>
    img.complete ? null : new Promise((ok) => { img.onload = img.onerror = ok; })));

  if (!NO_CELULAR) return window.print();
  // No app do celular, a impressão é feita pelo Android (plugin Impressora do app)
  try {
    const cap = window.Capacitor;
    const impressora = cap.registerPlugin ? cap.registerPlugin("Impressora") : cap.Plugins.Impressora;
    await impressora.imprimir({ nome: livroAtual.nome, larguraMm: tamanho.larg, alturaMm: tamanho.alt });
  } catch (e) {
    alert("Não foi possível abrir a impressão: " + (e.message || e));
  }
}

// ---------- Imprimir uma página só ----------
function escolherImpressaoUnica(num) {
  const g = geometria();
  // Folhas soltas: a página já ocupa a folha toda, não tem o que escolher
  if (!g.dobrada) return imprimirNoTamanhoDoLivro(num);
  const pagina = livroAtual.paginas[num - 1];
  const janela = $("#janela-geral");
  const fechar = () => janela.close();
  janela.replaceChildren(
    el("button", { class: "btn fechar", onclick: fechar }, el("span", { class: "icone" }, "✖️"), "Fechar"),
    el("h2", {}, `🖨️ Imprimir a página ${num}`),
    el("img", { class: "miniatura-unica", src: imagemUrl(pagina.img_id), alt: "" }),
    el("div", { class: "acoes-sync" },
      botao("📄", `Folha inteira (${g.nomePapel} ${g.deitada ? "deitada" : "em pé"})`, "A página ocupa a folha toda: bom para colorir avulsa",
        () => { fechar(); imprimirPaginaInteira(num); }, "primario grande"),
      el("p", { class: "dica" }, "O desenho fica grande, ocupando a folha toda."),
      botao("📖", "No tamanho do livro (meia folha)", "Sai na mesma posição que tem no livro",
        () => { fechar(); imprimirNoTamanhoDoLivro(num); }, "grande"),
      el("p", { class: "dica" }, "Sai igual ao livro, na mesma metade da folha. Bom para refazer uma página que estragou.")));
  janela.showModal();
}

function imprimirPaginaInteira(num) {
  const { paginas, ajuste, margem_mm, numerar } = livroAtual;
  const g = geometria();
  // A folha toda, na mesma orientação das páginas do livro
  const tamanho = g.deitada ? { larg: g.longo, alt: g.curto } : { larg: g.curto, alt: g.longo };
  const folha = el("div", { class: `pagina-inteira ${ajuste}` });
  folha.style.setProperty("--fl", tamanho.larg);
  folha.style.setProperty("--fa", tamanho.alt);
  folha.style.setProperty("--margem-mm", Math.max(8, margem_mm));
  folha.append(el("img", { src: imagemUrl(paginas[num - 1].img_id), alt: "" }));
  if (numerar) folha.append(el("span", { class: "numero-impresso" }, String(num)));
  mandarImprimir([folha], tamanho);
}

function imprimirNoTamanhoDoLivro(num) {
  // Descobre em que lado de qual folha a página fica e imprime só ela, na mesma metade
  const { folhas } = montarFolhas(livroAtual.paginas.length, livroAtual.modo);
  const lado = folhas.flatMap((f) => [f.frente, f.verso]).find((l) => l.includes(num));
  mandarImprimir([criarLado(lado.map((n) => (n === num ? n : null)), false)]);
}
$("#btn-imprimir").addEventListener("click", () => imprimir("tudo"));
$("#btn-frentes").addEventListener("click", () => imprimir("frentes"));
$("#btn-versos").addEventListener("click", () => imprimir("versos"));
window.addEventListener("afterprint", () => $("#impressao").replaceChildren());
$("#janela-geral").addEventListener("close", () => $("#janela-geral").replaceChildren());

if (NO_CELULAR) {
  document.body.classList.add("celular");
  $("#zona-titulo").textContent = "Toque aqui para escolher as imagens";
}

roteador();
