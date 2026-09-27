// Copia as bibliotecas de QR Code para static/vendor (o PC usa sem precisar de npm).
const fs = require("fs");
const path = require("path");

const raiz = path.join(__dirname, "..");
const destino = path.join(raiz, "static", "vendor");
fs.mkdirSync(destino, { recursive: true });

for (const [origem, nome] of [
  ["node_modules/qrcode-generator/dist/qrcode.js", "qrcode.js"],
  ["node_modules/jsqr/dist/jsQR.js", "jsQR.js"],
]) {
  fs.copyFileSync(path.join(raiz, origem), path.join(destino, nome));
  console.log(`copiado ${nome}`);
}
