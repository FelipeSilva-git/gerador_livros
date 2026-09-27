// Gera todos os ícones a partir de static/icone.svg, desenhando no Edge sem janela.
//   node scripts/gerar-icones.mjs
// Saída: ícone do Windows (.ico), ícones da página e ícones do app Android.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(raiz, "static", "icone.svg"), "utf8");
const res = join(raiz, "android", "app", "src", "main", "res");

// Variantes do desenho
const variantes = {
  quadrado: svg,
  redondo: svg.replace(/<rect id="caixa"[^>]*\/>/, '<circle cx="256" cy="256" r="256" fill="url(#fundo)"/>'),
  // Android "adaptive icon": só o desenho, menor, dentro da área segura
  frente: svg.replace(/<rect id="caixa"[^>]*\/>/, "")
    .replace('<g id="desenho">', '<g id="desenho" transform="translate(61.4 61.4) scale(0.76)">'),
};

const pedidos = [
  ...[16, 24, 32, 48, 64, 128, 256].map((t) => ({ v: "quadrado", t, arq: `ico-${t}` })),
  { v: "quadrado", t: 192, arq: join(raiz, "static", "icone-192.png") },
  { v: "quadrado", t: 512, arq: join(raiz, "static", "icone-512.png") },
  ...[["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]].flatMap(([d, t]) => [
    { v: "quadrado", t, arq: join(res, `mipmap-${d}`, "ic_launcher.png") },
    { v: "redondo", t, arq: join(res, `mipmap-${d}`, "ic_launcher_round.png") },
    { v: "frente", t: Math.round(t * 2.25), arq: join(res, `mipmap-${d}`, "ic_launcher_foreground.png") },
  ]),
];

// ---------- abre o Edge sem janela e conversa com ele ----------
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = join(tmpdir(), "livrinhos-icones");
const porta = 9345;
const proc = spawn(edge, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${porta}`,
  `--user-data-dir=${perfil}`, "about:blank"], { stdio: "ignore" });

let alvo;
for (let i = 0; i < 50 && !alvo; i++) {
  await new Promise((ok) => setTimeout(ok, 200));
  try { alvo = (await (await fetch(`http://127.0.0.1:${porta}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
}
const ws = new WebSocket(alvo.webSocketDebuggerUrl);
await new Promise((ok) => (ws.onopen = ok));
let n = 0;
const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pend.get(d.id)?.(d); pend.delete(d.id); };
const avaliar = (expression) => new Promise((ok) => {
  const id = ++n;
  pend.set(id, (d) => ok(d.result.result.value));
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});

const pngs = await avaliar(`(async () => {
  const variantes = ${JSON.stringify(variantes)};
  const pedidos = ${JSON.stringify(pedidos.map(({ v, t }) => ({ v, t })))};
  const imagens = {};
  for (const [nome, texto] of Object.entries(variantes)) {
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(texto);
    await img.decode();
    imagens[nome] = img;
  }
  return pedidos.map(({ v, t }) => {
    const c = document.createElement("canvas");
    c.width = c.height = t;
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(imagens[v], 0, 0, t, t);
    return c.toDataURL("image/png").split(",")[1];
  });
})()`);
ws.close();
proc.kill();

// ---------- grava os arquivos ----------
const ico = [];
pedidos.forEach((p, i) => {
  const dados = Buffer.from(pngs[i], "base64");
  if (p.arq.startsWith("ico-")) return ico.push({ t: p.t, dados });
  writeFileSync(p.arq, dados);
  console.log("ok", p.arq.replace(raiz, "."));
});

// .ico com as imagens PNG dentro (formato aceito desde o Windows Vista)
const cabecalho = Buffer.alloc(6 + 16 * ico.length);
cabecalho.writeUInt16LE(0, 0);
cabecalho.writeUInt16LE(1, 2);
cabecalho.writeUInt16LE(ico.length, 4);
let deslocamento = cabecalho.length;
ico.forEach(({ t, dados }, i) => {
  const e = 6 + 16 * i;
  cabecalho.writeUInt8(t >= 256 ? 0 : t, e);
  cabecalho.writeUInt8(t >= 256 ? 0 : t, e + 1);
  cabecalho.writeUInt16LE(1, e + 4);   // planos
  cabecalho.writeUInt16LE(32, e + 6);  // bits por pixel
  cabecalho.writeUInt32LE(dados.length, e + 8);
  cabecalho.writeUInt32LE(deslocamento, e + 12);
  deslocamento += dados.length;
});
mkdirSync(join(raiz, "instalador"), { recursive: true });
writeFileSync(join(raiz, "instalador", "livrinhos.ico"), Buffer.concat([cabecalho, ...ico.map((x) => x.dados)]));
console.log("ok ./instalador/livrinhos.ico");

// Fundo do ícone adaptativo do Android na cor do sistema
writeFileSync(join(res, "values", "ic_launcher_background.xml"),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#E36B35</color>\n</resources>\n');
setTimeout(() => { try { rmSync(perfil, { recursive: true, force: true }); } catch {} }, 1500);
