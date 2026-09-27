"use strict";

// Sincronização celular <-> PC pelo Wi-Fi de casa (não precisa de internet).
// - PC: mostra um QR Code com o endereço do PC na rede e o código de pareamento.
// - Celular: lê o QR Code e troca os livros com o PC, nos dois sentidos.
//   Vale a versão mais nova de cada livro; imagens que o outro lado já tem não são enviadas.

const janela = $("#janela-sync");
let relogioPC = null;
let camera = null;

function abrirJanela(...conteudo) {
  janela.replaceChildren(
    el("button", { class: "btn fechar", onclick: () => janela.close() }, el("span", { class: "icone" }, "✖️"), "Fechar"),
    ...conteudo);
  if (!janela.open) janela.showModal();
}

janela.addEventListener("close", () => {
  clearInterval(relogioPC);
  pararCamera();
  roteador(); // mostra o que chegou
});

// ---------- PC ----------
async function mostrarPareamentoPC() {
  const info = await fetch("/api/sync/pareamento").then((r) => r.json());
  if (!info.enderecos.length) {
    return abrirJanela(el("h2", {}, "📲 Sincronizar com o celular"),
      el("p", { class: "aviso" }, "Este computador não está conectado a nenhuma rede. Conecte no Wi‑Fi (ou no cabo do roteador) e tente de novo."));
  }
  const qr = qrcode(0, "M");
  qr.addData(JSON.stringify({ e: info.enderecos, p: info.porta, c: info.codigo }));
  qr.make();
  const caixaQR = el("div", { class: "qr" });
  caixaQR.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2 });

  const estado = el("p", { class: "estado-sync" }, "⏳ Esperando o celular…");
  abrirJanela(
    el("h2", {}, "📲 Sincronizar com o celular"),
    el("ol", { class: "passos" },
      el("li", {}, "O celular e este computador precisam estar ", el("b", {}, "no mesmo Wi‑Fi"), "."),
      el("li", {}, "No celular, abra o app ", el("b", {}, "Livrinhos"), " e toque em ", el("b", {}, "🔄 Sincronizar"), "."),
      el("li", {}, "Aponte a câmera do celular para este código:")),
    caixaQR,
    el("p", { class: "manual" }, "Sem câmera? No celular, toque em “Digitar o código” e use: ",
      el("b", {}, info.enderecos[0]), " e o código ", el("b", { class: "codigo" }, info.codigo)),
    estado,
    el("p", { class: "dica" }, "O celular não acha o computador? Na primeira vez, o Windows pergunta se o Python pode usar a rede: ",
      "clique em ", el("b", {}, "Permitir acesso"), ". Se não apareceu, feche o programa e abra de novo."));

  const antes = info.ultima_sync;
  relogioPC = setInterval(async () => {
    const i = await fetch("/api/sync/pareamento").then((r) => r.json()).catch(() => null);
    if (i && i.ultima_sync && i.ultima_sync !== antes) {
      estado.textContent = `✅ O celular está conectado (última troca às ${i.ultima_sync}). Quando o celular mostrar “Pronto”, pode fechar esta janela.`;
    }
  }, 2000);
}

// ---------- Celular ----------
const CHAVE_CONEXAO = "livrinhos-conexao";
function lerConexao() {
  try { return JSON.parse(localStorage.getItem(CHAVE_CONEXAO)); } catch { return null; }
}
function guardarConexao(con) {
  try { localStorage.setItem(CHAVE_CONEXAO, JSON.stringify(con)); } catch {}
}

function abrirSyncCelular() {
  const salvo = lerConexao();
  const estado = el("p", { class: "estado-sync" });
  const areaCamera = el("div", { class: "area-camera" });
  const acoes = el("div", { class: "acoes-sync" });

  const executar = async (con) => {
    pararCamera();
    areaCamera.replaceChildren();
    acoes.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const { recebidos, enviados, base } = await sincronizar(con, (msg) => { estado.textContent = "⏳ " + msg; });
      guardarConexao({ ...con, enderecos: [new URL(base).hostname, ...con.enderecos.filter((e) => e !== new URL(base).hostname)] });
      estado.textContent = recebidos + enviados === 0
        ? "✅ Pronto! Está tudo igual no celular e no computador."
        : `✅ Pronto! ${recebidos} livro(s) vieram do computador e ${enviados} foram para o computador.`;
    } catch (e) {
      estado.textContent = "❌ " + (e.message || e);
    }
    acoes.querySelectorAll("button").forEach((b) => { b.disabled = false; });
  };

  const lerQR = () => iniciarCamera(areaCamera, estado, executar);
  const digitar = () => {
    const ip = prompt("Endereço que aparece no computador (exemplo: 192.168.0.15):", salvo?.enderecos?.[0] || "");
    if (!ip) return;
    const codigo = prompt("Código de 6 números que aparece no computador:");
    if (!codigo) return;
    executar({ enderecos: [ip.trim().replace(/^https?:\/\//, "").replace(/:\d+.*$/, "")], porta: 8765, codigo: codigo.trim() });
  };

  if (salvo) acoes.append(botao("🔄", "Sincronizar agora", "Usar o computador de antes", () => executar(salvo), "primario grande"));
  acoes.append(
    botao("📷", salvo ? "Ler outro QR Code" : "Ler o QR Code do computador", "Abrir a câmera", lerQR, salvo ? "grande" : "primario grande"),
    botao("⌨️", "Digitar o código", "Para quando a câmera não funcionar", digitar, "grande"));

  abrirJanela(
    el("h2", {}, "🔄 Sincronizar com o computador"),
    el("p", { class: "explica" }, "No computador, abra o Livrinhos e clique em ", el("b", {}, "📲 Celular"),
      ". Os dois precisam estar no mesmo Wi‑Fi. Os livros vão e voltam: fica valendo a versão mais nova de cada um."),
    acoes, areaCamera, estado);
}

async function iniciarCamera(area, estado, aoLer) {
  pararCamera();
  estado.textContent = "📷 Aponte a câmera para o QR Code do computador…";
  const video = el("video", { playsinline: "", muted: "" });
  const tela = document.createElement("canvas");
  area.replaceChildren(video);
  try {
    const fluxo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    camera = { fluxo, quadro: null };
    video.srcObject = fluxo;
    await video.play();
  } catch (e) {
    area.replaceChildren();
    estado.textContent = "❌ Não consegui abrir a câmera. Permita o uso da câmera ou use “Digitar o código”.";
    return;
  }
  const ctx = tela.getContext("2d", { willReadFrequently: true });
  const procurar = () => {
    if (!camera) return;
    if (video.readyState >= 2) {
      tela.width = video.videoWidth;
      tela.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const achado = jsQR(ctx.getImageData(0, 0, tela.width, tela.height).data, tela.width, tela.height);
      if (achado) {
        try {
          const d = JSON.parse(achado.data);
          if (d.e && d.c) return aoLer({ enderecos: d.e, porta: d.p || 8765, codigo: String(d.c) });
        } catch {}
        estado.textContent = "Esse QR Code não é do Livrinhos. Aponte para o código que aparece no computador.";
      }
    }
    camera.quadro = requestAnimationFrame(procurar);
  };
  procurar();
}

function pararCamera() {
  if (!camera) return;
  cancelAnimationFrame(camera.quadro);
  camera.fluxo.getTracks().forEach((t) => t.stop());
  camera = null;
}

// Tenta cada endereço do PC até achar um que responda
async function encontrarPC(con, aviso) {
  for (const ip of con.enderecos) {
    const base = `http://${ip}:${con.porta}`;
    aviso(`Procurando o computador (${ip})…`);
    try {
      const r = await fetch(`${base}/api/sync/livros`, {
        headers: { "X-Codigo": con.codigo }, signal: AbortSignal.timeout(5000),
      });
      if (r.status === 401) throw new Error("Código errado. Leia o QR Code do computador de novo.");
      if (r.ok) return base;
    } catch (e) {
      if (e.message.startsWith("Código errado")) throw e;
    }
  }
  throw new Error("Não achei o computador. Confira se o programa está aberto no PC e se os dois estão no mesmo Wi‑Fi.");
}

async function sincronizar(con, aviso) {
  const base = await encontrarPC(con, aviso);
  const pedir = async (metodo, caminho, corpo, tipo) => {
    const opcoes = { method: metodo, headers: { "X-Codigo": con.codigo }, signal: AbortSignal.timeout(120000) };
    if (corpo instanceof Blob) {
      opcoes.body = corpo;
      opcoes.headers["Content-Type"] = tipo || corpo.type;
    } else if (corpo !== undefined) {
      opcoes.body = JSON.stringify(corpo);
      opcoes.headers["Content-Type"] = "application/json";
    }
    const r = await fetch(base + caminho, opcoes);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.erro || `Erro ${r.status} ao falar com o computador`);
    }
    return r;
  };

  aviso("Comparando os livros…");
  const remotos = new Map((await (await pedir("GET", "/api/sync/livros")).json()).map((l) => [l.uuid, l]));
  const locais = new Map((await ArmazemLocal.manifesto()).map((l) => [l.uuid, l]));
  let recebidos = 0, enviados = 0;

  for (const uuid of new Set([...remotos.keys(), ...locais.keys()])) {
    const r = remotos.get(uuid), l = locais.get(uuid);

    if (r && (!l || r.atualizado_em > l.atualizado_em)) {
      if (!l && r.excluido) continue; // excluído no PC e nunca veio para cá
      // PC mais novo: traz para o celular
      const livro = await (await pedir("GET", `/api/sync/livros/${uuid}`)).json();
      aviso(`Recebendo “${livro.nome}”…`);
      const faltam = await ArmazemLocal.imagensQueFaltam([...new Set(livro.paginas.map((p) => p.img_id).filter(Boolean))]);
      for (const [i, id] of faltam.entries()) {
        aviso(`Recebendo “${livro.nome}”: imagem ${i + 1} de ${faltam.length}…`);
        await ArmazemLocal.salvarImagem(id, await (await pedir("GET", `/api/sync/imagens/${id}`)).blob());
      }
      await ArmazemLocal.aplicarLivro(livro);
      recebidos++;
    } else if (l && (!r || l.atualizado_em > r.atualizado_em)) {
      if (!r && l.excluido) continue; // excluído aqui e o PC nunca teve
      // Celular mais novo: manda para o PC (primeiro as imagens, depois o livro)
      const livro = await ArmazemLocal.exportarLivro(uuid);
      aviso(`Enviando “${livro.nome}”…`);
      const ids = [...new Set(livro.paginas.map((p) => p.img_id).filter(Boolean))];
      const { faltando } = await (await pedir("POST", "/api/sync/imagens/faltando", { ids })).json();
      for (const [i, id] of faltando.entries()) {
        aviso(`Enviando “${livro.nome}”: imagem ${i + 1} de ${faltando.length}…`);
        const img = await ArmazemLocal.lerImagem(id);
        await pedir("PUT", `/api/sync/imagens/${id}`, img.blob, img.mime);
      }
      await pedir("POST", "/api/sync/livros", livro);
      enviados++;
    }
  }
  return { recebidos, enviados, base };
}

// ---------- Botão da tela inicial ----------
const botaoSync = $("#btn-sync");
botaoSync.replaceChildren(
  el("span", { class: "icone" }, NO_CELULAR ? "🔄" : "📲"),
  NO_CELULAR ? "Sincronizar" : "Celular");
botaoSync.title = NO_CELULAR ? "Trocar os livros com o computador" : "Trocar os livros com o celular";
botaoSync.addEventListener("click", () => {
  const abrir = NO_CELULAR ? abrirSyncCelular : mostrarPareamentoPC;
  Promise.resolve(abrir()).catch((e) => alert(e.message || e));
});
