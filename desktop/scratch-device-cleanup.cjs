
const { readPairingSnapshot, revokePairingDevice } = require("./dist/mobile-pairing.js");
(async () => {
  const base = "http://127.0.0.1:17731";
  const snap = await readPairingSnapshot({ bridgeBase: base, publicUrl: "https://m.zhuquan.xyz" });
  const rows = snap.devices.map(d => ({ id: d.id, name: d.name, seen: d.lastSeenAt || 0 }));
  rows.sort((a, b) => b.seen - a.seen);
  const keep = new Set();
  const realPhone = rows.find(r => (r.name || "").includes("24069RA21C"));
  if (realPhone) keep.add(realPhone.id);
  const newestEmu = rows.find(r => (r.name || "").includes("sdk_gphone") || (r.name || "").includes("emulator"));
  if (newestEmu) keep.add(newestEmu.id);
  const doomed = rows.filter(r => !keep.has(r.id));
  console.log("保留:", rows.filter(r => keep.has(r.id)).map(r => r.name + "/" + r.id.slice(0,8)));
  console.log("撤销:", doomed.length);
  for (const d of doomed) {
    const res = await revokePairingDevice(base, d.id);
    console.log("  ", d.name, d.id.slice(0,8), res.ok ? "已解除" : ("失败 " + res.error));
  }
  const after = await readPairingSnapshot({ bridgeBase: base, publicUrl: "https://m.zhuquan.xyz" });
  console.log("剩余设备:", after.devices.length, JSON.stringify(after.devices.map(d => d.name)));
})().catch(e => { console.error("FAILED", e); process.exit(1); });
