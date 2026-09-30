"""Servidor local do Livrinhos de Colorir.

Guarda livros e imagens em um banco SQLite (historias.db) e serve a
interface que fica na pasta static/. Usa só a biblioteca padrão do Python.

Também recebe o app do celular pela rede Wi-Fi de casa para sincronizar
(rotas /api/sync/*, protegidas pelo código de pareamento).

Uso: python server.py   (depois abrir http://localhost:8765)
"""

import json
import mimetypes
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
import uuid
import webbrowser
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

PORTA = 8765
PASTA = Path(__file__).resolve().parent
BANCO = PASTA / "historias.db"
ESTATICOS = PASTA / "static"

VERSAO_BANCO = 3
MODOS = {"livreto", "empilhado", "soltas"}  # soltas = sem dobrar, 1 página por lado
AJUSTES = {"inteira", "preencher"}
ORIENTACOES = {"retrato", "paisagem"}      # páginas em pé ou deitadas
PAPEIS = {"A4", "A3", "A5", "carta", "oficio", "legal", "personalizado"}
# Formato do livro: valores usados quando o campo não veio
FORMATO_PADRAO = {
    "modo": "livreto", "ajuste": "inteira", "margem_mm": 5.0, "numerar": 1,
    "papel": "A4", "papel_larg": 210.0, "papel_alt": 297.0, "orientacao": "retrato",
}
ID_VALIDO = re.compile(r"[A-Za-z0-9-]{8,64}")

_trava = threading.Lock()
_ultima_sync = {"quando": None}


def agora_ms():
    return int(time.time() * 1000)


def novo_id():
    return str(uuid.uuid4())


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


# ---------- Estrutura do banco ----------
ESQUEMA = """
CREATE TABLE IF NOT EXISTS livros (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid          TEXT NOT NULL UNIQUE,
    nome          TEXT NOT NULL,
    modo          TEXT NOT NULL DEFAULT 'livreto',
    ajuste        TEXT NOT NULL DEFAULT 'inteira',
    margem_mm     REAL NOT NULL DEFAULT 5,
    numerar       INTEGER NOT NULL DEFAULT 1,
    papel         TEXT NOT NULL DEFAULT 'A4',
    papel_larg    REAL NOT NULL DEFAULT 210,   -- mm, papel em pé
    papel_alt     REAL NOT NULL DEFAULT 297,
    orientacao    TEXT NOT NULL DEFAULT 'retrato',
    criado_em     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    atualizado_em INTEGER NOT NULL,          -- ms; usado para saber quem é mais novo
    excluido      INTEGER NOT NULL DEFAULT 0 -- livro excluído fica marcado para a exclusão sincronizar
);
CREATE TABLE IF NOT EXISTS paginas (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    livro_id INTEGER NOT NULL REFERENCES livros(id) ON DELETE CASCADE,
    ordem    INTEGER NOT NULL,
    uuid     TEXT NOT NULL,
    nome     TEXT NOT NULL,
    img_id   TEXT                            -- NULL = página em branco
);
CREATE INDEX IF NOT EXISTS idx_paginas_livro ON paginas(livro_id, ordem);
CREATE TABLE IF NOT EXISTS imagens (
    img_id TEXT PRIMARY KEY,                 -- muda sempre que a imagem muda
    mime   TEXT NOT NULL,
    dados  BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);
"""


def criar_tabelas():
    with conectar() as con:
        (versao,) = con.execute("PRAGMA user_version").fetchone()
        tabelas = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if versao < 2 and "paginas" in tabelas:
            migrar_para_v2(con)
        con.executescript(ESQUEMA)
        # v3: tamanho do papel e orientação das páginas
        colunas = {c["name"] for c in con.execute("PRAGMA table_info(livros)")}
        for coluna, definicao in (
            ("papel", "TEXT NOT NULL DEFAULT 'A4'"),
            ("papel_larg", "REAL NOT NULL DEFAULT 210"),
            ("papel_alt", "REAL NOT NULL DEFAULT 297"),
            ("orientacao", "TEXT NOT NULL DEFAULT 'retrato'"),
        ):
            if coluna not in colunas:
                con.execute(f"ALTER TABLE livros ADD COLUMN {coluna} {definicao}")
        con.execute(f"PRAGMA user_version = {VERSAO_BANCO}")
        if not con.execute("SELECT 1 FROM config WHERE chave = 'codigo'").fetchone():
            codigo = f"{secrets.randbelow(10**6):06d}"
            con.execute("INSERT INTO config VALUES ('codigo', ?)", (codigo,))


def migrar_para_v2(con):
    """Banco da primeira versão: imagens dentro de paginas e sem uuid."""
    colunas_livros = {c["name"] for c in con.execute("PRAGMA table_info(livros)")}
    colunas_paginas = {c["name"] for c in con.execute("PRAGMA table_info(paginas)")}
    agora = agora_ms()

    con.execute("ALTER TABLE livros RENAME TO livros_v1")
    con.execute("ALTER TABLE paginas RENAME TO paginas_v1")
    con.execute("DROP INDEX IF EXISTS idx_paginas_livro")
    con.executescript(ESQUEMA)

    numerar = "numerar" if "numerar" in colunas_livros else "1"
    for l in con.execute(f"SELECT *, {numerar} AS num FROM livros_v1").fetchall():
        con.execute(
            """INSERT INTO livros (id, uuid, nome, modo, ajuste, margem_mm, numerar, criado_em, atualizado_em)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (l["id"], novo_id(), l["nome"], l["modo"], l["ajuste"], l["margem_mm"], l["num"],
             l["criado_em"], agora),
        )
    tem_dados = "dados" in colunas_paginas
    for p in con.execute("SELECT * FROM paginas_v1 ORDER BY livro_id, ordem, id").fetchall():
        img_id = None
        if tem_dados and p["mime"] != "vazio" and p["dados"]:
            img_id = novo_id()
            con.execute("INSERT INTO imagens VALUES (?, ?, ?)", (img_id, p["mime"], p["dados"]))
        con.execute(
            "INSERT INTO paginas (id, livro_id, ordem, uuid, nome, img_id) VALUES (?, ?, ?, ?, ?, ?)",
            (p["id"], p["livro_id"], p["ordem"], novo_id(), p["nome"], img_id),
        )
    con.execute("DROP TABLE paginas_v1")
    con.execute("DROP TABLE livros_v1")


def formato_valido(dados):
    """Só os campos de formato que vieram e são válidos (o resto é ignorado)."""
    r = {}
    for campo, opcoes in (("modo", MODOS), ("ajuste", AJUSTES), ("orientacao", ORIENTACOES), ("papel", PAPEIS)):
        if dados.get(campo) in opcoes:
            r[campo] = dados[campo]
    if "numerar" in dados:
        r["numerar"] = 1 if dados["numerar"] else 0
    for campo, minimo, maximo in (("margem_mm", 0, 30), ("papel_larg", 50, 1000), ("papel_alt", 50, 1000)):
        if campo in dados:
            try:
                r[campo] = max(float(minimo), min(float(maximo), float(dados[campo])))
            except (TypeError, ValueError):
                pass
    return r


def codigo_pareamento(con):
    return con.execute("SELECT valor FROM config WHERE chave = 'codigo'").fetchone()[0]


def tocar(con, livro_id):
    """Marca o livro como alterado agora (para a sincronização)."""
    con.execute("UPDATE livros SET atualizado_em = ? WHERE id = ?", (agora_ms(), livro_id))


def limpar_imagens_soltas(con):
    con.execute(
        "DELETE FROM imagens WHERE img_id NOT IN (SELECT img_id FROM paginas WHERE img_id IS NOT NULL)"
    )


def livro_dict(con, livro_id):
    livro = con.execute(
        "SELECT * FROM livros WHERE id = ? AND excluido = 0", (livro_id,)
    ).fetchone()
    if livro is None:
        return None
    paginas = con.execute(
        "SELECT id, ordem, uuid, nome, img_id FROM paginas WHERE livro_id = ? ORDER BY ordem, id",
        (livro_id,),
    ).fetchall()
    dados = dict(livro)
    dados["paginas"] = [{**dict(p), "vazia": p["img_id"] is None} for p in paginas]
    return dados


def livro_para_sync(con, livro):
    """Formato usado para trocar um livro inteiro com o celular."""
    paginas = con.execute(
        "SELECT uuid, nome, img_id FROM paginas WHERE livro_id = ? ORDER BY ordem, id",
        (livro["id"],),
    ).fetchall()
    campos = ("uuid", "nome", *FORMATO_PADRAO, "criado_em", "atualizado_em", "excluido")
    return {**{c: livro[c] for c in campos}, "paginas": [dict(p) for p in paginas]}


def enderecos_na_rede():
    """IPs deste PC na rede de casa (o celular usa para se conectar)."""
    ips = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # não envia nada; só descobre a rota
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except OSError:
        pass
    unicos = [ip for i, ip in enumerate(ips) if ip not in ips[:i] and not ip.startswith("127.")]
    # redes de casa costumam ser 192.168.x.x
    return sorted(unicos, key=lambda ip: (not ip.startswith("192.168."), not ip.startswith("10.")))


class ServidorDuplo(ThreadingHTTPServer):
    """Escuta IPv6 e IPv4 ao mesmo tempo ("localhost" pode ser qualquer um dos dois)."""
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def criar_servidor():
    # Todas as placas de rede: o celular precisa alcançar pelo Wi-Fi.
    # Pela rede, só as rotas de sincronização funcionam (e com o código).
    try:
        return ServidorDuplo(("::", PORTA), Handler)
    except OSError as e:
        if getattr(e, "winerror", None) == 10048 or e.errno in (98, 48):  # porta em uso
            raise
        return ThreadingHTTPServer(("0.0.0.0", PORTA), Handler)  # PC sem IPv6


class Handler(BaseHTTPRequestHandler):
    server_version = "Livrinhos/2.0"

    def log_message(self, formato, *args):
        pass  # silencioso no terminal

    # ---------- utilidades ----------
    def cabecalhos_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Codigo")

    def responder_json(self, dados, status=HTTPStatus.OK):
        corpo = json.dumps(dados, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.cabecalhos_cors()
        self.end_headers()
        self.wfile.write(corpo)

    def responder_bytes(self, dados, tipo, cache=False):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(dados)))
        # img_id muda sempre que a imagem muda, então pode guardar em cache para sempre
        self.send_header("Cache-Control", "max-age=31536000, immutable" if cache else "no-cache")
        self.cabecalhos_cors()
        self.end_headers()
        self.wfile.write(dados)

    def erro(self, status, mensagem):
        self.responder_json({"erro": mensagem}, status)

    def ler_corpo(self):
        tamanho = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(tamanho) if tamanho else b""

    def ler_json(self):
        corpo = self.ler_corpo()
        return json.loads(corpo.decode("utf-8")) if corpo else {}

    def caminho(self):
        return self.path.split("?")[0]

    def rota(self, padrao):
        return re.fullmatch(padrao, self.caminho())

    def do_proprio_pc(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def autorizado(self):
        """O próprio PC pode tudo. Pela rede, só a sincronização com o código certo."""
        if self.do_proprio_pc():
            return True
        if not self.caminho().startswith("/api/sync/"):
            self.erro(HTTPStatus.FORBIDDEN, "Acesso permitido só neste computador")
            return False
        with conectar() as con:
            codigo = codigo_pareamento(con)
        if not secrets.compare_digest(self.headers.get("X-Codigo") or "", codigo):
            self.erro(HTTPStatus.UNAUTHORIZED, "Código errado. Leia o QR Code de novo.")
            return False
        _ultima_sync["quando"] = time.strftime("%H:%M:%S")
        return True

    def ler_imagem_enviada(self):
        mime = (self.headers.get("Content-Type") or "").split(";")[0]
        if not mime.startswith("image/"):
            self.erro(HTTPStatus.BAD_REQUEST, "Envie um arquivo de imagem")
            return None
        dados = self.ler_corpo()
        if not dados:
            self.erro(HTTPStatus.BAD_REQUEST, "Imagem vazia")
            return None
        return mime, dados

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.cabecalhos_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- GET ----------
    def do_GET(self):
        if not self.autorizado():
            return

        if self.rota(r"/api/livros"):
            with conectar() as con:
                linhas = con.execute(
                    """SELECT l.*, COUNT(p.id) AS total_paginas,
                              (SELECT img_id FROM paginas WHERE livro_id = l.id AND img_id IS NOT NULL
                               ORDER BY ordem, id LIMIT 1) AS capa_img
                       FROM livros l LEFT JOIN paginas p ON p.livro_id = l.id
                       WHERE l.excluido = 0
                       GROUP BY l.id ORDER BY l.criado_em DESC, l.id DESC"""
                ).fetchall()
            return self.responder_json([dict(l) for l in linhas])

        if m := self.rota(r"/api/livros/(\d+)"):
            with conectar() as con:
                livro = livro_dict(con, int(m[1]))
            if livro is None:
                return self.erro(HTTPStatus.NOT_FOUND, "Livro não encontrado")
            return self.responder_json(livro)

        if m := self.rota(r"/api/(?:sync/)?imagens/([A-Za-z0-9-]+)"):
            with conectar() as con:
                img = con.execute("SELECT mime, dados FROM imagens WHERE img_id = ?", (m[1],)).fetchone()
            if img is None:
                return self.erro(HTTPStatus.NOT_FOUND, "Imagem não encontrada")
            return self.responder_bytes(img["dados"], img["mime"], cache=True)

        # --- sincronização ---
        if self.rota(r"/api/sync/pareamento"):
            if not self.do_proprio_pc():
                return self.erro(HTTPStatus.FORBIDDEN, "Só neste computador")
            with conectar() as con:
                codigo = codigo_pareamento(con)
            return self.responder_json({
                "enderecos": enderecos_na_rede(), "porta": PORTA, "codigo": codigo,
                "ultima_sync": _ultima_sync["quando"],
            })

        if self.rota(r"/api/sync/livros"):
            with conectar() as con:
                linhas = con.execute("SELECT uuid, atualizado_em, excluido FROM livros").fetchall()
            return self.responder_json([dict(l) for l in linhas])

        if m := self.rota(r"/api/sync/livros/([A-Za-z0-9-]+)"):
            with conectar() as con:
                livro = con.execute("SELECT * FROM livros WHERE uuid = ?", (m[1],)).fetchone()
                if livro is None:
                    return self.erro(HTTPStatus.NOT_FOUND, "Livro não encontrado")
                return self.responder_json(livro_para_sync(con, livro))

        return self.servir_estatico()

    def servir_estatico(self):
        caminho = unquote(self.caminho()).lstrip("/") or "index.html"
        arquivo = (ESTATICOS / caminho).resolve()
        if ESTATICOS not in arquivo.parents or not arquivo.is_file():
            return self.erro(HTTPStatus.NOT_FOUND, "Não encontrado")
        tipo = mimetypes.guess_type(arquivo.name)[0] or "application/octet-stream"
        if tipo.startswith("text/") or tipo.endswith("javascript"):
            tipo += "; charset=utf-8"
        return self.responder_bytes(arquivo.read_bytes(), tipo)

    # ---------- POST ----------
    def do_POST(self):
        if not self.autorizado():
            return

        if self.rota(r"/api/livros"):
            nome = (self.ler_json().get("nome") or "").strip() or "Livro sem nome"
            with _trava, conectar() as con:
                cur = con.execute(
                    "INSERT INTO livros (uuid, nome, atualizado_em) VALUES (?, ?, ?)",
                    (novo_id(), nome, agora_ms()),
                )
                livro = livro_dict(con, cur.lastrowid)
            return self.responder_json(livro, HTTPStatus.CREATED)

        if m := self.rota(r"/api/livros/(\d+)/paginas"):
            livro_id = int(m[1])
            if self.headers.get("X-Pagina-Vazia"):
                # Página em branco de propósito (ex.: verso da capa)
                nome, imagem = "página em branco", None
            else:
                imagem = self.ler_imagem_enviada()
                if imagem is None:
                    return
                nome = unquote(self.headers.get("X-Nome-Arquivo") or "imagem")
            with _trava, conectar() as con:
                if not con.execute(
                    "SELECT 1 FROM livros WHERE id = ? AND excluido = 0", (livro_id,)
                ).fetchone():
                    return self.erro(HTTPStatus.NOT_FOUND, "Livro não encontrado")
                img_id = None
                if imagem:
                    img_id = novo_id()
                    con.execute("INSERT INTO imagens VALUES (?, ?, ?)", (img_id, *imagem))
                (ordem,) = con.execute(
                    "SELECT COALESCE(MAX(ordem), 0) + 1 FROM paginas WHERE livro_id = ?", (livro_id,)
                ).fetchone()
                cur = con.execute(
                    "INSERT INTO paginas (livro_id, ordem, uuid, nome, img_id) VALUES (?, ?, ?, ?, ?)",
                    (livro_id, ordem, novo_id(), nome, img_id),
                )
                tocar(con, livro_id)
            return self.responder_json({"id": cur.lastrowid, "ordem": ordem}, HTTPStatus.CREATED)

        # --- sincronização ---
        if self.rota(r"/api/sync/imagens/faltando"):
            ids = [i for i in self.ler_json().get("ids", []) if ID_VALIDO.fullmatch(str(i))]
            with conectar() as con:
                existentes = {
                    r[0] for r in con.execute(
                        f"SELECT img_id FROM imagens WHERE img_id IN ({','.join('?' * len(ids))})", ids
                    )
                } if ids else set()
            return self.responder_json({"faltando": [i for i in ids if i not in existentes]})

        if self.rota(r"/api/sync/livros"):
            return self.receber_livro(self.ler_json())

        return self.erro(HTTPStatus.NOT_FOUND, "Rota não encontrada")

    def receber_livro(self, livro):
        """Grava o livro vindo do celular, se ele for mais novo que o daqui."""
        if not ID_VALIDO.fullmatch(str(livro.get("uuid", ""))):
            return self.erro(HTTPStatus.BAD_REQUEST, "Livro inválido")
        paginas = livro.get("paginas") or []
        with _trava, conectar() as con:
            atual = con.execute("SELECT * FROM livros WHERE uuid = ?", (livro["uuid"],)).fetchone()
            if atual and atual["atualizado_em"] >= int(livro["atualizado_em"]):
                return self.responder_json({"ok": True, "ignorado": True})
            precisa = {p["img_id"] for p in paginas if p.get("img_id")}
            if precisa:
                tem = {r[0] for r in con.execute(
                    f"SELECT img_id FROM imagens WHERE img_id IN ({','.join('?' * len(precisa))})",
                    list(precisa),
                )}
                if precisa - tem:
                    return self.erro(HTTPStatus.CONFLICT, "Faltam imagens deste livro")
            campos = {
                "nome": str(livro.get("nome") or "Livro sem nome"),
                "atualizado_em": int(livro["atualizado_em"]),
                "excluido": 1 if livro.get("excluido") else 0,
                # campo que não veio (app antigo) mantém o valor daqui
                **({} if atual else FORMATO_PADRAO),
                **formato_valido(livro),
            }
            if atual:
                livro_id = atual["id"]
                con.execute(
                    f"UPDATE livros SET {', '.join(f'{c} = ?' for c in campos)} WHERE id = ?",
                    (*campos.values(), livro_id),
                )
            else:
                campos["uuid"] = livro["uuid"]
                campos["criado_em"] = livro.get("criado_em") or time.strftime("%Y-%m-%d %H:%M:%S")
                cur = con.execute(
                    f"INSERT INTO livros ({', '.join(campos)}) VALUES ({', '.join('?' * len(campos))})",
                    tuple(campos.values()),
                )
                livro_id = cur.lastrowid
            con.execute("DELETE FROM paginas WHERE livro_id = ?", (livro_id,))
            if not livro.get("excluido"):
                for ordem, p in enumerate(paginas, start=1):
                    con.execute(
                        "INSERT INTO paginas (livro_id, ordem, uuid, nome, img_id) VALUES (?, ?, ?, ?, ?)",
                        (livro_id, ordem, str(p.get("uuid") or novo_id()), str(p.get("nome") or "imagem"),
                         p.get("img_id") or None),
                    )
            limpar_imagens_soltas(con)
        return self.responder_json({"ok": True})

    # ---------- PUT / PATCH ----------
    def do_PATCH(self):
        if not self.autorizado():
            return
        m = self.rota(r"/api/livros/(\d+)")
        if not m:
            return self.erro(HTTPStatus.NOT_FOUND, "Rota não encontrada")
        livro_id = int(m[1])
        dados = self.ler_json()
        campos = formato_valido(dados)
        if "nome" in dados:
            campos["nome"] = str(dados["nome"]).strip() or "Livro sem nome"
        with _trava, conectar() as con:
            if campos:
                con.execute(
                    f"UPDATE livros SET {', '.join(f'{c} = ?' for c in campos)} WHERE id = ?",
                    (*campos.values(), livro_id),
                )
                tocar(con, livro_id)
            livro = livro_dict(con, livro_id)
        if livro is None:
            return self.erro(HTTPStatus.NOT_FOUND, "Livro não encontrado")
        return self.responder_json(livro)

    def do_PUT(self):
        if not self.autorizado():
            return

        # Trocar a imagem de uma página, mantendo a posição dela no livro
        if m := self.rota(r"/api/paginas/(\d+)/imagem"):
            imagem = self.ler_imagem_enviada()
            if imagem is None:
                return
            nome = unquote(self.headers.get("X-Nome-Arquivo") or "imagem")
            with _trava, conectar() as con:
                pag = con.execute("SELECT livro_id FROM paginas WHERE id = ?", (int(m[1]),)).fetchone()
                if pag is None:
                    return self.erro(HTTPStatus.NOT_FOUND, "Página não encontrada")
                img_id = novo_id()
                con.execute("INSERT INTO imagens VALUES (?, ?, ?)", (img_id, *imagem))
                con.execute(
                    "UPDATE paginas SET nome = ?, img_id = ? WHERE id = ?", (nome, img_id, int(m[1]))
                )
                tocar(con, pag["livro_id"])
                limpar_imagens_soltas(con)
            return self.responder_json({"ok": True})

        # Reordenar páginas: {"ids": [5, 2, 9, ...]}
        if m := self.rota(r"/api/livros/(\d+)/ordem"):
            livro_id = int(m[1])
            ids = [int(i) for i in self.ler_json().get("ids", [])]
            with _trava, conectar() as con:
                for posicao, pagina_id in enumerate(ids, start=1):
                    con.execute(
                        "UPDATE paginas SET ordem = ? WHERE id = ? AND livro_id = ?",
                        (posicao, pagina_id, livro_id),
                    )
                tocar(con, livro_id)
                livro = livro_dict(con, livro_id)
            return self.responder_json(livro)

        # --- sincronização: imagem vinda do celular ---
        if m := self.rota(r"/api/sync/imagens/([A-Za-z0-9-]+)"):
            if not ID_VALIDO.fullmatch(m[1]):
                return self.erro(HTTPStatus.BAD_REQUEST, "Imagem inválida")
            imagem = self.ler_imagem_enviada()
            if imagem is None:
                return
            with _trava, conectar() as con:
                con.execute("INSERT OR IGNORE INTO imagens VALUES (?, ?, ?)", (m[1], *imagem))
            return self.responder_json({"ok": True})

        return self.erro(HTTPStatus.NOT_FOUND, "Rota não encontrada")

    # ---------- DELETE ----------
    def do_DELETE(self):
        if not self.autorizado():
            return

        # Apagar só a imagem: a página continua no lugar, em branco
        if m := self.rota(r"/api/paginas/(\d+)/imagem"):
            with _trava, conectar() as con:
                pag = con.execute("SELECT livro_id FROM paginas WHERE id = ?", (int(m[1]),)).fetchone()
                if pag:
                    con.execute(
                        "UPDATE paginas SET nome = 'página em branco', img_id = NULL WHERE id = ?",
                        (int(m[1]),),
                    )
                    tocar(con, pag["livro_id"])
                    limpar_imagens_soltas(con)
            return self.responder_json({"ok": True})

        # Excluir livro: fica marcado como excluído para a exclusão ir para o celular também
        if m := self.rota(r"/api/livros/(\d+)"):
            with _trava, conectar() as con:
                con.execute("DELETE FROM paginas WHERE livro_id = ?", (int(m[1]),))
                con.execute(
                    "UPDATE livros SET excluido = 1, atualizado_em = ? WHERE id = ?",
                    (agora_ms(), int(m[1])),
                )
                limpar_imagens_soltas(con)
            return self.responder_json({"ok": True})

        if m := self.rota(r"/api/paginas/(\d+)"):
            with _trava, conectar() as con:
                pag = con.execute("SELECT livro_id FROM paginas WHERE id = ?", (int(m[1]),)).fetchone()
                if pag:
                    con.execute("DELETE FROM paginas WHERE id = ?", (int(m[1]),))
                    tocar(con, pag["livro_id"])
                    limpar_imagens_soltas(con)
            return self.responder_json({"ok": True})

        return self.erro(HTTPStatus.NOT_FOUND, "Rota não encontrada")


def main():
    # --servico: roda escondido (iniciado pelo Windows ao ligar o PC), sem abrir o navegador
    servico = "--servico" in sys.argv
    if servico:
        # pythonw não tem janela: erros vão para um arquivo de log
        log = open(PASTA / "servidor.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log
        print(time.strftime("[%Y-%m-%d %H:%M:%S] iniciando como serviço"))
    criar_tabelas()
    try:
        servidor = criar_servidor()
    except OSError:
        print(f"A porta {PORTA} já está em uso: o Livrinhos já está rodando.")
        if not servico:
            webbrowser.open(f"http://localhost:{PORTA}")
        sys.exit(1)
    endereco = f"http://localhost:{PORTA}"
    print(f"Livrinhos de Colorir rodando em {endereco}")
    if not servico:
        print("Deixe esta janela aberta enquanto usa. Para fechar, aperte Ctrl+C.")
        threading.Timer(0.8, lambda: webbrowser.open(endereco)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
