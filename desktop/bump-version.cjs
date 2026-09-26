// 版本号修改小工具。用法（在 desktop/ 目录下跑）：
//   node bump-version.cjs 0.6.0            # 只改桌面端 package.json
//   node bump-version.cjs 0.6.0 0.2.25     # 同时改桥接插件版本
//
// 版本号约定（2026-09-26 起）：对外一位小数——桌面 package.json 写 X.Y.0，
// 发布管线（desktop.yml）自动把尾段 ".0" 去掉（0.6.0 → 0.6：tag、资产名、
// latest.json、界面展示一致）；桥接插件版本仍按三段递增（0.2.24 → 0.2.25）。
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
