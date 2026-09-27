"""Servidor local do Livrinhos de Colorir.

Guarda livros e imagens em um banco SQLite (historias.db) e serve a
interface que fica na pasta static/. Usa só a biblioteca padrão do Python.

Uso: python server.py   (depois abrir http://localhost:8765)
"""

import json
import mimetypes
import re
import sqlite3
import threading
from contextlib import contextmanager
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

PORTA = 8765
PASTA = Path(__file__).resolve().parent
BANCO = PASTA / "historias.db"
ESTATICOS = PASTA / "static"

MODOS = {"livreto", "empilhado"}
AJUSTES = {"inteira", "preencher"}
VAZIA = "vazio"  # mime das páginas deixadas em branco de propósito

_trava = threading.Lock()


@contextmanager
def conectar():
    """Abre o banco, faz commit no fim (ou rollback se der erro) e fecha."""
    con = sqlite3.connect(BANCO)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        with con:
            yield con
    finally:
        con.close()


def criar_tabelas():
    with conectar() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS livros (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                nome      TEXT NOT NULL,
                modo      TEXT NOT NULL DEFAULT 'livreto',
                ajuste    TEXT NOT NULL DEFAULT 'inteira',
                margem_mm REAL NOT NULL DEFAULT 5,
                criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            );
            CREATE TABLE IF NOT EXISTS paginas (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                livro_id  INTEGER NOT NULL REFERENCES livros(id) ON DELETE CASCADE,
                ordem     INTEGER NOT NULL,
                nome      TEXT NOT NULL,
                mime      TEXT NOT NULL,
                dados     BLOB NOT NULL,
                criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            );
            CREATE INDEX IF NOT EXISTS idx_paginas_livro ON paginas(livro_id, ordem);
            """
        )
        # Bancos antigos: versão da imagem, usada para o navegador não mostrar a imagem velha após trocar
        colunas = {c["name"] for c in con.execute("PRAGMA table_info(paginas)")}
        if "versao" not in colunas:
            con.execute("ALTER TABLE paginas ADD COLUMN versao INTEGER NOT NULL DEFAULT 1")
        colunas = {c["name"] for c in con.execute("PRAGMA table_info(livros)")}
        if "numerar" not in colunas:
            con.execute("ALTER TABLE livros ADD COLUMN numerar INTEGER NOT NULL DEFAULT 1")


def livro_dict(con, livro_id):
    livro = con.execute("SELECT * FROM livros WHERE id = ?", (livro_id,)).fetchone()
    if livro is None:
        return None
    paginas = con.execute(
        """SELECT id, ordem, nome, versao, mime = ? AS vazia
           FROM paginas WHERE livro_id = ? ORDER BY ordem, id""",
        (VAZIA, livro_id),
    ).fetchall()
    dados = dict(livro)
    dados["paginas"] = [{**dict(p), "vazia": bool(p["vazia"])} for p in paginas]
    return dados


class Handler(BaseHTTPRequestHandler):
    server_version = "Livrinhos/1.0"

    def log_message(self, formato, *args):
        pass  # silencioso no terminal

    # ---------- utilidades ----------
    def responder_json(self, dados, status=HTTPStatus.OK):
        corpo = json.dumps(dados, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def erro(self, status, mensagem):
        self.responder_json({"erro": mensagem}, status)

    def ler_corpo(self):
        tamanho = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(tamanho) if tamanho else b""

    def ler_json(self):
        corpo = self.ler_corpo()
        return json.loads(corpo.decode("utf-8")) if corpo else {}

    def rota(self, padrao):
        return re.fullmatch(padrao, self.path.split("?")[0])

    # ---------- GET ----------
    def do_GET(self):
        if self.rota(r"/api/livros"):
            with conectar() as con:
                linhas = con.execute(
                    """SELECT l.*, COUNT(p.id) AS total_paginas,
                              (SELECT id FROM paginas WHERE livro_id = l.id AND mime != :vazia
                               ORDER BY ordem, id LIMIT 1) AS capa_id,
                              (SELECT versao FROM paginas WHERE livro_id = l.id AND mime != :vazia
                               ORDER BY ordem, id LIMIT 1) AS capa_versao
                       FROM livros l LEFT JOIN paginas p ON p.livro_id = l.id
                       GROUP BY l.id ORDER BY l.criado_em DESC, l.id DESC""",
                    {"vazia": VAZIA},
                ).fetchall()
            return self.responder_json([dict(l) for l in linhas])

        if m := self.rota(r"/api/livros/(\d+)"):
            with conectar() as con:
                livro = livro_dict(con, int(m[1]))
            if livro is None:
                return self.erro(HTTPStatus.NOT_FOUND, "Livro não encontrado")
            return self.responder_json(livro)

        if m := self.rota(r"/api/paginas/(\d+)/imagem"):
            with conectar() as con:
                pag = con.execute(
                    "SELECT mime, dados FROM paginas WHERE id = ?", (int(m[1]),)
                ).fetchone()
            if pag is None or pag["mime"] == VAZIA:
                return self.erro(HTTPStatus.NOT_FOUND, "Página não encontrada")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", pag["mime"])
            self.send_header("Content-Length", str(len(pag["dados"])))
            self.send_header("Cache-Control", "max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(pag["dados"])
            return

        return self.servir_estatico()

    def servir_estatico(self):
        caminho = unquote(self.path.split("?")[0]).lstrip("/") or "index.html"
        arquivo = (ESTATICOS / caminho).resolve()
        if ESTATICOS not in arquivo.parents or not arquivo.is_file():
            return self.erro(HTTPStatus.NOT_FOUND, "Não encontrado")
        corpo = arquivo.read_bytes()
        tipo = mimetypes.guess_type(arquivo.name)[0] or "application/octet-stream"
        if tipo.startswith("text/") or tipo.endswith("javascript"):
            tipo += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(corpo)

    # ---------- POST ----------
    def do_POST(self):
        if self.rota(r"/api/livros"):
            nome = (self.ler_json().get("nome") or "").strip() or "Livro sem nome"
            with _trava, conectar() as con:
                cur = con.execute("INSERT INTO livros (nome) VALUES (?)", (nome,))
                livro = livro_dict(con, cur.lastrowid)
            return self.responder_json(livro, HTTPStatus.CREATED)

        if m := self.rota(r"/api/livros/(\d+)/paginas"):
            livro_id = int(m[1])
            if self.headers.get("X-Pagina-Vazia"):
                # Página em branco de propósito (ex.: verso da capa)
                mime, nome, dados = VAZIA, "página em branco", b""
            else:
                mime = (self.headers.get("Content-Type") or "").split(";")[0]
                if not mime.startswith("image/"):
                    return self.erro(HTTPStatus.BAD_REQUEST, "Envie um arquivo de imagem")
                nome = unquote(self.headers.get("X-Nome-Arquivo") or "imagem")
                dados = self.ler_corpo()
                if not dados:
                    return self.erro(HTTPStatus.BAD_REQUEST, "Imagem vazia")
            with _trava, conectar() as con:
                if not con.execute("SELECT 1 FROM livros WHERE id = ?", (livro_id,)).fetchone():
                    return self.erro(HTTPStatus.NOT_FOUND, "Livro não encontrado")
                (ordem,) = con.execute(
                    "SELECT COALESCE(MAX(ordem), 0) + 1 FROM paginas WHERE livro_id = ?",
                    (livro_id,),
                ).fetchone()
                cur = con.execute(
                    "INSERT INTO paginas (livro_id, ordem, nome, mime, dados) VALUES (?, ?, ?, ?, ?)",
                    (livro_id, ordem, nome, mime, sqlite3.Binary(dados)),
                )
            return self.responder_json(
                {"id": cur.lastrowid, "ordem": ordem, "nome": nome}, HTTPStatus.CREATED
            )

        return self.erro(HTTPStatus.NOT_FOUND, "Rota não encontrada")

    # ---------- PUT / PATCH ----------
    def do_PATCH(self):
        m = self.rota(r"/api/livros/(\d+)")
        if not m:
            return self.erro(HTTPStatus.NOT_FOUND, "Rota não encontrada")
        livro_id = int(m[1])
        dados = self.ler_json()
        campos, valores = [], []
        if "nome" in dados:
            campos.append("nome = ?")
            valores.append(str(dados["nome"]).strip() or "Livro sem nome")
        if dados.get("modo") in MODOS:
            campos.append("modo = ?")
            valores.append(dados["modo"])
        if dados.get("ajuste") in AJUSTES:
            campos.append("ajuste = ?")
            valores.append(dados["ajuste"])
        if "numerar" in dados:
            campos.append("numerar = ?")
            valores.append(1 if dados["numerar"] else 0)
        if "margem_mm" in dados:
            campos.append("margem_mm = ?")
            valores.append(max(0.0, min(30.0, float(dados["margem_mm"]))))
        with _trava, conectar() as con:
            if campos:
                con.execute(
                    f"UPDATE livros SET {', '.join(campos)} WHERE id = ?", (*valores, livro_id)
                )
            livro = livro_dict(con, livro_id)
        if livro is None:
            return self.erro(HTTPStatus.NOT_FOUND, "Livro não encontrado")
        return self.responder_json(livro)

    def do_PUT(self):
        # Trocar a imagem de uma página, mantendo a posição dela no livro
        if m := self.rota(r"/api/paginas/(\d+)/imagem"):
            mime = (self.headers.get("Content-Type") or "").split(";")[0]
            if not mime.startswith("image/"):
                return self.erro(HTTPStatus.BAD_REQUEST, "Envie um arquivo de imagem")
            nome = unquote(self.headers.get("X-Nome-Arquivo") or "imagem")
            dados = self.ler_corpo()
            if not dados:
                return self.erro(HTTPStatus.BAD_REQUEST, "Imagem vazia")
            with _trava, conectar() as con:
                cur = con.execute(
                    """UPDATE paginas SET nome = ?, mime = ?, dados = ?, versao = versao + 1
                       WHERE id = ?""",
                    (nome, mime, sqlite3.Binary(dados), int(m[1])),
                )
                if cur.rowcount == 0:
                    return self.erro(HTTPStatus.NOT_FOUND, "Página não encontrada")
            return self.responder_json({"ok": True})

        # Reordenar páginas: {"ids": [5, 2, 9, ...]}
        m = self.rota(r"/api/livros/(\d+)/ordem")
        if not m:
            return self.erro(HTTPStatus.NOT_FOUND, "Rota não encontrada")
        livro_id = int(m[1])
        ids = [int(i) for i in self.ler_json().get("ids", [])]
        with _trava, conectar() as con:
            for posicao, pagina_id in enumerate(ids, start=1):
                con.execute(
                    "UPDATE paginas SET ordem = ? WHERE id = ? AND livro_id = ?",
                    (posicao, pagina_id, livro_id),
                )
            livro = livro_dict(con, livro_id)
        return self.responder_json(livro)

    # ---------- DELETE ----------
    def do_DELETE(self):
        # Apagar só a imagem: a página continua no lugar, em branco
        if m := self.rota(r"/api/paginas/(\d+)/imagem"):
            with _trava, conectar() as con:
                con.execute(
                    """UPDATE paginas SET nome = 'página em branco', mime = ?, dados = x'',
                       versao = versao + 1 WHERE id = ?""",
                    (VAZIA, int(m[1])),
                )
            return self.responder_json({"ok": True})

        if m := self.rota(r"/api/livros/(\d+)"):
            with _trava, conectar() as con:
                con.execute("DELETE FROM livros WHERE id = ?", (int(m[1]),))
            return self.responder_json({"ok": True})

        if m := self.rota(r"/api/paginas/(\d+)"):
            with _trava, conectar() as con:
                con.execute("DELETE FROM paginas WHERE id = ?", (int(m[1]),))
            return self.responder_json({"ok": True})

        return self.erro(HTTPStatus.NOT_FOUND, "Rota não encontrada")


def main():
    criar_tabelas()
    servidor = ThreadingHTTPServer(("127.0.0.1", PORTA), Handler)
    endereco = f"http://localhost:{PORTA}"
    print(f"Livrinhos de Colorir rodando em {endereco}")
    print("Deixe esta janela aberta enquanto usa. Para fechar, aperte Ctrl+C.")
    threading.Timer(0.8, lambda: webbrowser.open(endereco)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
