const fs = require('fs');
const bump = (file, version) => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.version = version;
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  console.log(file, '→', version);
};
bump('resources/plugins/mobile-bridge/package.json', '0.2.11');
bump('package.json', '0.5.21');
