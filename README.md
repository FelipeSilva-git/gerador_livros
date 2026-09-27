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

## App para celular (Android)

O mesmo sistema também funciona como app Android, sem internet.

- **Baixar:** na página do repositório, em **Releases → App Android (mais recente)**, baixe
  o `Livrinhos.apk` no celular e toque nele para instalar (o Android pede para permitir
  "instalar apps desta fonte"). Versões novas podem ser instaladas por cima: os livros continuam.
- O APK é gerado sozinho pelo GitHub (`.github/workflows/apk.yml`) a cada envio para a `main`.
- No celular, a impressão usa o sistema do Android (impressora Wi‑Fi ou "Salvar como PDF").

### Sincronizar celular e computador

1. O celular e o PC precisam estar **no mesmo Wi‑Fi** (não precisa de internet).
2. No PC, abra o Livrinhos e clique em **📲 Celular**: aparece um QR Code.
3. No app do celular, toque em **🔄 Sincronizar** e leia o QR Code.

Os livros vão nos dois sentidos: fica valendo a versão mais nova de cada livro, e
livros excluídos em um lado são excluídos no outro. Na primeira vez, o Windows pergunta
se o Python pode usar a rede: clique em **Permitir acesso**.

Pela rede, o PC só aceita a sincronização com o código do QR Code; o resto do sistema
só funciona no próprio computador.

## Onde ficam os dados

No PC, tudo (livros e imagens) fica no arquivo `historias.db` (SQLite), na mesma pasta.
Para fazer backup, basta copiar esse arquivo. No celular, os livros ficam dentro do app;
sincronizar com o PC também serve de backup.

## Estrutura

- `server.py`: servidor local e banco de dados (só biblioteca padrão do Python)
- `static/`: a tela (HTML, CSS e JavaScript), usada no PC e no app
  - `armazem.js`: onde os dados ficam (servidor no PC, banco interno no celular)
  - `sync.js`: sincronização pelo Wi‑Fi (QR Code)
- `android/`: projeto do app Android (Capacitor), com o plugin de impressão
- `npm run android:sync`: copia a tela para o projeto Android
