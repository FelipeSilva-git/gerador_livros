# Livrinhos de Colorir

Monta livrinhos de histórias para colorir em folhas **A4 paisagem**, dobradas ao meio,
com 4 páginas por folha (2 na frente e 2 no verso).

Você coloca as imagens na ordem da história e o sistema calcula sozinho em qual folha
e em qual lado cada página vai sair, pronto para imprimir.

## Como usar

1. Ter o [Python 3](https://www.python.org/downloads/) instalado.
2. Dar dois cliques em **`Abrir Livrinhos.bat`** (ou rodar `python server.py`).
3. O navegador abre em `http://localhost:8765`.
4. Criar um livro, arrastar as imagens (nomes como `01.png`, `02.png`… já entram em ordem).
5. Imprimir: **1º as frentes**, recolocar as folhas na bandeja, **2º os versos**.

## Montagens

| Montagem | Como fica o livro |
|---|---|
| **Livreto grampeado** | As folhas vão uma dentro da outra e são dobradas juntas. |
| **Folhas dobradas e coladas** | Cada folha é dobrada sozinha e as folhas são coladas em sequência. |

## Onde ficam os dados

Tudo (livros e imagens) fica no arquivo `historias.db` (SQLite), na mesma pasta.
Para fazer backup, basta copiar esse arquivo.

## Estrutura

- `server.py`: servidor local e banco de dados (só biblioteca padrão do Python)
- `static/`: a tela (HTML, CSS e JavaScript)
