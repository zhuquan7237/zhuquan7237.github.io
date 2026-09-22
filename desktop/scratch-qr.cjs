
const qrcode = require("qrcode-generator");
const fs = require("fs");
const link = process.argv[2];
const qr = qrcode(0, "M");
qr.addData(link);
qr.make();
const dataUrl = qr.createDataURL(6, 4);
fs.writeFileSync(process.argv[3], Buffer.from(dataUrl.split(",")[1], "base64"));
console.log("modules", qr.getModuleCount(), "png bytes", fs.statSync(process.argv[3]).size);
const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
fs.writeFileSync(process.argv[3].replace(".png", ".svg"), svg);
console.log("svg bytes", svg.length);
