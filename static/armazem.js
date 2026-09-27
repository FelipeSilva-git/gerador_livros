"use strict";

// Onde os livros ficam guardados.
// - No PC: no servidor Python (SQLite), pelas rotas /api/...
// - No celular (app): no banco interno do próprio app (IndexedDB), sem internet.
// As duas versões têm os mesmos métodos, então a tela não precisa saber qual está usando.

const NO_CELULAR =
  !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
  new URLSearchParams(location.search).has("local"); // ?local=1 testa o modo celular no PC

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
    adicionarPagina: (livroId, arq) => arq
      ? api("POST", `/api/livros/${livroId}/paginas`, arq, cabecalhosArquivo(arq))
      : api("POST", `/api/livros/${livroId}/paginas`, undefined, { "X-Pagina-Vazia": "1" }),
    reordenar: (livroId, ids) => api("PUT", `/api/livros/${livroId}/ordem`, { ids }),
    trocarImagem: (paginaId, arq) => api("PUT", `/api/paginas/${paginaId}/imagem`, arq, cabecalhosArquivo(arq)),
    apagarImagem: (paginaId) => api("DELETE", `/api/paginas/${paginaId}/imagem`),
    removerPagina: (paginaId) => api("DELETE", `/api/paginas/${paginaId}`),
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
      l.paginas = (await paginasDoLivro(paginas, id)).map((p) => ({ ...p, vazia: !p.img_id }));
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

  const CAMPOS = ["nome", "modo", "ajuste", "margem_mm", "numerar"];

  return {
    imagemUrl: (imgId) => urls.get(imgId) || "",

    async listarLivros() {
      const lista = await transacao(["livros", "paginas"], "readonly", async ({ livros, paginas }) => {
        const todos = (await pedido(livros.getAll())).filter((l) => !l.excluido);
        for (const l of todos) {
          const pags = await paginasDoLivro(paginas, l.id);
          l.total_paginas = pags.length;
          l.capa_img = pags.find((p) => p.img_id)?.img_id || null;
        }
        return todos.sort((a, b) => (b.criado_em || "").localeCompare(a.criado_em || "") || b.id - a.id);
      });
      await prepararImagens(lista.map((l) => l.capa_img));
      return lista;
    },

    async criarLivro(nome) {
      const id = await transacao(["livros"], "readwrite", ({ livros }) => pedido(livros.add({
        uuid: novoId(), nome: (nome || "").trim() || "Livro sem nome",
        modo: "livreto", ajuste: "inteira", margem_mm: 5, numerar: 1,
        criado_em: new Date().toISOString(), atualizado_em: Date.now(), excluido: 0,
      })));
      return livroCompleto(id);
    },

    obterLivro: (id) => livroCompleto(id),

    async atualizarLivro(id, campos) {
      await alterarLivro(id, (_, livro) => {
        for (const c of CAMPOS) if (c in campos) livro[c] = campos[c];
        if ("nome" in campos) livro.nome = String(campos.nome).trim() || "Livro sem nome";
        if ("numerar" in campos) livro.numerar = campos.numerar ? 1 : 0;
        if ("margem_mm" in campos) livro.margem_mm = Math.max(0, Math.min(30, Number(campos.margem_mm) || 0));
      });
      return livroCompleto(id);
    },

    async excluirLivro(id) {
      await alterarLivro(id, async ({ paginas }, livro) => {
        for (const p of await paginasDoLivro(paginas, id)) paginas.delete(p.id);
        livro.excluido = 1; // fica marcado para a exclusão ir para o PC também
      });
    },

    async adicionarPagina(livroId, arq) {
      await alterarLivro(livroId, async ({ paginas, imagens }) => {
        const pags = await paginasDoLivro(paginas, livroId);
        paginas.add({
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
        return { ...resto, paginas: pags.map(({ uuid, nome, img_id }) => ({ uuid, nome, img_id })) };
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
          ...(atual ? { id: atual.id } : {}),
          uuid: s.uuid, nome: s.nome, modo: s.modo, ajuste: s.ajuste, margem_mm: s.margem_mm,
          numerar: s.numerar, criado_em: s.criado_em, atualizado_em: s.atualizado_em, excluido: s.excluido ? 1 : 0,
        };
        const id = await pedido(lojas.livros.put(livro));
        for (const p of await paginasDoLivro(lojas.paginas, id)) lojas.paginas.delete(p.id);
        if (!livro.excluido) {
          s.paginas.forEach((p, i) => lojas.paginas.add({
            livro_id: id, ordem: i + 1, uuid: p.uuid, nome: p.nome, img_id: p.img_id || null,
          }));
        }
        await limparImagensSoltas(lojas);
      });
    },
  };
})();

const armazem = NO_CELULAR ? ArmazemLocal : ArmazemServidor;
const imagemUrl = (imgId) => armazem.imagemUrl(imgId);
