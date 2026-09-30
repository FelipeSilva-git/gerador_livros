"use strict";

// Onde os livros ficam guardados.
// - No PC: no servidor Python (SQLite), pelas rotas /api/...
// - No celular (app): no banco interno do próprio app (IndexedDB), sem internet.
// As duas versões têm os mesmos métodos, então a tela não precisa saber qual está usando.

const NO_CELULAR =
  !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
  new URLSearchParams(location.search).has("local"); // ?local=1 testa o modo celular no PC

// Formato do livro: valores de quem ainda não escolheu (livros antigos = A4, em pé, livreto)
const FORMATO_PADRAO = {
  modo: "livreto", ajuste: "inteira", margem_mm: 5, numerar: 1,
  papel: "A4", papel_larg: 210, papel_alt: 297, orientacao: "retrato",
  capa_verso_branco: 1, contracapa_verso_branco: 1,
};
const SECOES = ["historia", "capa", "contracapa"]; // onde a página fica no livro

// Confere os campos de formato que vieram (igual ao servidor)
function formatoValido(dados) {
  const r = {};
  const opcoes = {
    modo: ["livreto", "empilhado", "soltas"], ajuste: ["inteira", "preencher"],
    orientacao: ["retrato", "paisagem"], papel: ["A4", "A3", "A5", "carta", "oficio", "legal", "personalizado"],
  };
  for (const [campo, validos] of Object.entries(opcoes)) if (validos.includes(dados[campo])) r[campo] = dados[campo];
  for (const campo of ["numerar", "capa_verso_branco", "contracapa_verso_branco"]) {
    if (campo in dados) r[campo] = dados[campo] ? 1 : 0;
  }
  for (const [campo, min, max] of [["margem_mm", 0, 30], ["papel_larg", 50, 1000], ["papel_alt", 50, 1000]]) {
    const n = Number(dados[campo]);
    if (campo in dados && Number.isFinite(n)) r[campo] = Math.max(min, Math.min(max, n));
  }
  return r;
}

function novoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}

// ---------- PC: servidor ----------
const ArmazemServidor = (() => {
  async function api(metodo, url, corpo, cabecalhos = {}) {
    const opcoes = { method: metodo, headers: { ...cabecalhos } };
    if (corpo instanceof Blob) {
      opcoes.body = corpo;
    } else if (corpo !== undefined) {
      opcoes.body = JSON.stringify(corpo);
      opcoes.headers["Content-Type"] = "application/json";
    }
    const resp = await fetch(url, opcoes);
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(dados.erro || `Erro ${resp.status}`);
    return dados;
  }
  const cabecalhosArquivo = (arq) => ({
    "Content-Type": arq.type,
    "X-Nome-Arquivo": encodeURIComponent(arq.name || "imagem"),
  });

  return {
    imagemUrl: (imgId) => `/api/imagens/${imgId}`,
    listarLivros: () => api("GET", "/api/livros"),
    criarLivro: (nome) => api("POST", "/api/livros", { nome }),
    obterLivro: (id) => api("GET", `/api/livros/${id}`),
    atualizarLivro: (id, campos) => api("PATCH", `/api/livros/${id}`, campos),
    excluirLivro: (id) => api("DELETE", `/api/livros/${id}`),
    adicionarPagina: (livroId, arq, secao = "historia") => arq
      ? api("POST", `/api/livros/${livroId}/paginas`, arq, { ...cabecalhosArquivo(arq), "X-Secao": secao })
      : api("POST", `/api/livros/${livroId}/paginas`, undefined, { "X-Pagina-Vazia": "1", "X-Secao": secao }),
    reordenar: (livroId, ids) => api("PUT", `/api/livros/${livroId}/ordem`, { ids }),
    trocarImagem: (paginaId, arq) => api("PUT", `/api/paginas/${paginaId}/imagem`, arq, cabecalhosArquivo(arq)),
    apagarImagem: (paginaId) => api("DELETE", `/api/paginas/${paginaId}/imagem`),
    removerPagina: (paginaId) => api("DELETE", `/api/paginas/${paginaId}`),
    mudarSecao: (paginaId, secao) => api("PUT", `/api/paginas/${paginaId}/secao`, { secao }),
  };
})();

// ---------- Celular: banco interno (IndexedDB) ----------
const ArmazemLocal = (() => {
  let bancoAberto;
  const banco = () => bancoAberto ??= new Promise((ok, falha) => {
    const r = indexedDB.open("livrinhos", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("livros", { keyPath: "id", autoIncrement: true })
        .createIndex("uuid", "uuid", { unique: true });
      db.createObjectStore("paginas", { keyPath: "id", autoIncrement: true })
        .createIndex("livro_id", "livro_id");
      db.createObjectStore("imagens", { keyPath: "img_id" }); // { img_id, mime, blob }
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => falha(r.error);
  });

  const pedido = (r) => new Promise((ok, falha) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => falha(r.error);
  });

  // Roda "fn" numa transação com as lojas pedidas; tudo ou nada.
  async function transacao(nomes, modo, fn) {
    const t = (await banco()).transaction(nomes, modo);
    const fim = new Promise((ok, falha) => {
      t.oncomplete = ok;
      t.onerror = t.onabort = () => falha(t.error || new Error("Erro ao salvar"));
    });
    const lojas = Object.fromEntries(nomes.map((n) => [n, t.objectStore(n)]));
    let resultado;
    try {
      resultado = await fn(lojas);
    } catch (e) {
      try { t.abort(); } catch {}
      throw e;
    }
    await fim;
    return resultado;
  }

  // Endereços das imagens para o <img>: criados a partir do que está guardado
  const urls = new Map();
  async function prepararImagens(ids) {
    const faltam = [...new Set(ids)].filter((id) => id && !urls.has(id));
    if (!faltam.length) return;
    await transacao(["imagens"], "readonly", async ({ imagens }) => {
      for (const id of faltam) {
        const img = await pedido(imagens.get(id));
        if (img) urls.set(id, URL.createObjectURL(img.blob));
      }
    });
  }

  const paginasDoLivro = async (paginas, livroId) =>
    (await pedido(paginas.index("livro_id").getAll(livroId))).sort((a, b) => a.ordem - b.ordem || a.id - b.id);

  async function livroCompleto(id) {
    const livro = await transacao(["livros", "paginas"], "readonly", async ({ livros, paginas }) => {
      const l = await pedido(livros.get(id));
      if (!l || l.excluido) return null;
      for (const [c, v] of Object.entries(FORMATO_PADRAO)) if (!(c in l)) l[c] = v;
      l.paginas = (await paginasDoLivro(paginas, id)).map((p) => ({ secao: "historia", ...p, vazia: !p.img_id }));
      return l;
    });
    if (!livro) throw new Error("Livro não encontrado");
    await prepararImagens(livro.paginas.map((p) => p.img_id));
    return livro;
  }

  function tocar(livro) {
    livro.atualizado_em = Math.max(Date.now(), (livro.atualizado_em || 0) + 1);
  }

  // Muda um livro e marca como alterado agora (para a sincronização)
  async function alterarLivro(livroId, fn) {
    await transacao(["livros", "paginas", "imagens"], "readwrite", async (lojas) => {
      const livro = await pedido(lojas.livros.get(livroId));
      if (!livro || livro.excluido) throw new Error("Livro não encontrado");
      await fn(lojas, livro);
      tocar(livro);
      lojas.livros.put(livro);
      await limparImagensSoltas(lojas);
    });
  }

  async function limparImagensSoltas({ paginas, imagens }) {
    const usadas = new Set((await pedido(paginas.getAll())).map((p) => p.img_id).filter(Boolean));
    for (const id of await pedido(imagens.getAllKeys())) {
      if (!usadas.has(id)) {
        imagens.delete(id);
        if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
      }
    }
  }

  function guardarImagem(imagens, arq) {
    const img_id = novoId();
    imagens.put({ img_id, mime: arq.type, blob: new Blob([arq], { type: arq.type }) });
    return img_id;
  }

  async function paginaELivro(paginaId) {
    const p = await transacao(["paginas"], "readonly", ({ paginas }) => pedido(paginas.get(paginaId)));
    if (!p) throw new Error("Página não encontrada");
    return p;
  }

  return {
    imagemUrl: (imgId) => urls.get(imgId) || "",

    async listarLivros() {
      const lista = await transacao(["livros", "paginas"], "readonly", async ({ livros, paginas }) => {
        const todos = (await pedido(livros.getAll())).filter((l) => !l.excluido);
        for (const l of todos) {
          for (const [c, v] of Object.entries(FORMATO_PADRAO)) if (!(c in l)) l[c] = v;
          const pags = await paginasDoLivro(paginas, l.id);
          l.total_paginas = pags.length;
          l.capa_img = (pags.find((p) => p.secao === "capa" && p.img_id) || pags.find((p) => p.img_id))?.img_id || null;
        }
        return todos.sort((a, b) => (b.criado_em || "").localeCompare(a.criado_em || "") || b.id - a.id);
      });
      await prepararImagens(lista.map((l) => l.capa_img));
      return lista;
    },

    async criarLivro(nome) {
      const id = await transacao(["livros"], "readwrite", ({ livros }) => pedido(livros.add({
        uuid: novoId(), nome: (nome || "").trim() || "Livro sem nome",
        ...FORMATO_PADRAO,
        criado_em: new Date().toISOString(), atualizado_em: Date.now(), excluido: 0,
      })));
      return livroCompleto(id);
    },

    obterLivro: (id) => livroCompleto(id),

    async atualizarLivro(id, campos) {
      await alterarLivro(id, (_, livro) => {
        Object.assign(livro, formatoValido(campos));
        if ("nome" in campos) livro.nome = String(campos.nome).trim() || "Livro sem nome";
      });
      return livroCompleto(id);
    },

    async excluirLivro(id) {
      await alterarLivro(id, async ({ paginas }, livro) => {
        for (const p of await paginasDoLivro(paginas, id)) paginas.delete(p.id);
        livro.excluido = 1; // fica marcado para a exclusão ir para o PC também
      });
    },

    async adicionarPagina(livroId, arq, secao = "historia") {
      await alterarLivro(livroId, async ({ paginas, imagens }) => {
        const pags = await paginasDoLivro(paginas, livroId);
        // só existe uma capa e uma contracapa: a nova substitui a antiga
        if (secao !== "historia") for (const p of pags) if (p.secao === secao) paginas.delete(p.id);
        paginas.add({
          secao: SECOES.includes(secao) ? secao : "historia",
          livro_id: livroId, uuid: novoId(),
          ordem: pags.length ? Math.max(...pags.map((p) => p.ordem)) + 1 : 1,
          nome: arq ? arq.name || "imagem" : "página em branco",
          img_id: arq ? guardarImagem(imagens, arq) : null,
        });
      });
    },

    async reordenar(livroId, ids) {
      await alterarLivro(livroId, async ({ paginas }) => {
        for (const p of await paginasDoLivro(paginas, livroId)) {
          const pos = ids.indexOf(p.id);
          if (pos >= 0) paginas.put({ ...p, ordem: pos + 1 });
        }
      });
      return livroCompleto(livroId);
    },

    async trocarImagem(paginaId, arq) {
      const p = await paginaELivro(paginaId);
      await alterarLivro(p.livro_id, ({ paginas, imagens }) => {
        paginas.put({ ...p, nome: arq.name || "imagem", img_id: guardarImagem(imagens, arq) });
      });
    },

    async apagarImagem(paginaId) {
      const p = await paginaELivro(paginaId);
      await alterarLivro(p.livro_id, ({ paginas }) => {
        paginas.put({ ...p, nome: "página em branco", img_id: null });
      });
    },

    async removerPagina(paginaId) {
      const p = await paginaELivro(paginaId);
      await alterarLivro(p.livro_id, ({ paginas }) => { paginas.delete(paginaId); });
    },

    // Muda a página de lugar no livro (história, capa ou contracapa)
    async mudarSecao(paginaId, secao) {
      if (!SECOES.includes(secao)) throw new Error("Lugar inválido");
      const p = await paginaELivro(paginaId);
      await alterarLivro(p.livro_id, async ({ paginas }) => {
        const pags = await paginasDoLivro(paginas, p.livro_id);
        const historia = pags.filter((x) => (x.secao || "historia") === "historia");
        if (secao === "historia") {
          // volta para a história: a capa no começo, a contracapa no fim
          const ordens = historia.map((x) => x.ordem);
          const ordem = !ordens.length ? 1 : p.secao === "capa" ? Math.min(...ordens) - 1 : Math.max(...ordens) + 1;
          paginas.put({ ...p, secao: "historia", ordem });
        } else {
          // só existe uma capa e uma contracapa: a que já estava volta para a história
          for (const x of pags) if (x.secao === secao && x.id !== p.id) paginas.put({ ...x, secao: "historia" });
          paginas.put({ ...p, secao });
        }
      });
    },

    // ----- usados pela sincronização -----
    async manifesto() {
      return transacao(["livros"], "readonly", async ({ livros }) =>
        (await pedido(livros.getAll())).map(({ uuid, atualizado_em, excluido }) => ({ uuid, atualizado_em, excluido })));
    },

    async exportarLivro(uuid) {
      return transacao(["livros", "paginas"], "readonly", async ({ livros, paginas }) => {
        const l = await pedido(livros.index("uuid").get(uuid));
        const pags = await paginasDoLivro(paginas, l.id);
        const { id, ...resto } = l;
        return { ...resto, paginas: pags.map(({ uuid, nome, img_id, secao }) => ({ uuid, nome, img_id, secao: secao || "historia" })) };
      });
    },

    async imagensQueFaltam(ids) {
      return transacao(["imagens"], "readonly", async ({ imagens }) => {
        const faltam = [];
        for (const id of ids) if (!(await pedido(imagens.getKey(id)))) faltam.push(id);
        return faltam;
      });
    },

    lerImagem: (id) => transacao(["imagens"], "readonly", ({ imagens }) => pedido(imagens.get(id))),

    salvarImagem: (id, blob) => transacao(["imagens"], "readwrite", ({ imagens }) => {
      imagens.put({ img_id: id, mime: blob.type, blob });
    }),

    // Grava um livro vindo do PC, se ele for mais novo que o daqui
    async aplicarLivro(s) {
      await transacao(["livros", "paginas", "imagens"], "readwrite", async (lojas) => {
        const atual = await pedido(lojas.livros.index("uuid").get(s.uuid));
        if (atual && atual.atualizado_em >= s.atualizado_em) return;
        const livro = {
          ...FORMATO_PADRAO,
          ...(atual || {}), // campo que não veio (PC antigo) mantém o valor daqui
          ...formatoValido(s),
          uuid: s.uuid, nome: s.nome, criado_em: s.criado_em, atualizado_em: s.atualizado_em,
          excluido: s.excluido ? 1 : 0,
        };
        const id = await pedido(lojas.livros.put(livro));
        for (const p of await paginasDoLivro(lojas.paginas, id)) lojas.paginas.delete(p.id);
        if (!livro.excluido) {
          s.paginas.forEach((p, i) => lojas.paginas.add({
            livro_id: id, ordem: i + 1, uuid: p.uuid, nome: p.nome, img_id: p.img_id || null,
            secao: SECOES.includes(p.secao) ? p.secao : "historia",
          }));
        }
        await limparImagensSoltas(lojas);
      });
    },
  };
})();

const armazem = NO_CELULAR ? ArmazemLocal : ArmazemServidor;
const imagemUrl = (imgId) => armazem.imagemUrl(imgId);
