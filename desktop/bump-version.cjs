// 版本号修改小工具。用法（在 desktop/ 目录下跑）：
//   node bump-version.cjs 0.6.0            # 只改桌面端 package.json
//   node bump-version.cjs 0.6.0 0.2.25     # 同时改桥接插件版本
//
// 版本号约定（2026-09-26 起）：三段、每段一位数——0.6.0 → 0.6.1 → … → 0.6.9，
// 补丁到 9 后进位（0.7.0）。package.json 直接写这个三段号，发布管线原样使用
// （tag、资产名、清单都是三段——不要出现 0.6 这种两段式）。
const fs = require('fs');

const [desktopVersion, bridgeVersion] = process.argv.slice(2);
if (!desktopVersion) {
  console.error('用法：node bump-version.cjs <desktopVersion 如 0.6.0> [bridgeVersion 如 0.2.25]');
  process.exit(1);
}

const bump = (file, version) => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.version = version;
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  console.log(file, '→', version);
};

bump('package.json', desktopVersion);
if (bridgeVersion) bump('resources/plugins/mobile-bridge/package.json', bridgeVersion);
