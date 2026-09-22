
const { readPairingSnapshot, rotatePairing, revokePairingDevice, formatPairCode, pairingLink } = require("./dist/mobile-pairing.js");
(async () => {
  const base = "http://127.0.0.1:17731";
  const snap = await readPairingSnapshot({ bridgeBase: base, publicUrl: "https://m.zhuquan.xyz", ensure: true });
  console.log("ok:", snap.ok, "| error:", snap.error ?? "-");
  console.log("pairCode:", JSON.stringify(snap.pairCode), "| 剩余秒数:", Math.round((snap.pairExpiresAt - Date.now())/1000));
  console.log("pairLink:", snap.pairLink);
  console.log("qrSvg:", snap.qrSvg ? snap.qrSvg.length + " 字节" : "null");
  console.log("devices:", snap.devices.length, JSON.stringify(snap.devices.map(d => [d.name, d.scopes.join("+"), d.lastSeenAt ? "seen" : "never"])));
  console.log("--- 纯函数抽查");
  console.log("formatPairCode('gjf6-bfkc') =", formatPairCode("gjf6-bfkc"));
  console.log("pairingLink('https://m.zhuquan.xyz/', 'GJF6-BFKC') =", pairingLink("https://m.zhuquan.xyz/", "GJF6-BFKC"));
})().catch(e => { console.error("FAILED", e); process.exit(1); });
