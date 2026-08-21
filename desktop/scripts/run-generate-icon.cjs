const { spawnSync } = require("node:child_process");
const path = require("node:path");

const script = path.join(__dirname, "generate-icon.py");
const candidates = process.platform === "win32" ? ["python3", "python", "py"] : ["python3", "python"];
let lastStatus = 1;

for (const command of candidates) {
  const result = spawnSync(command, [script], { stdio: "inherit" });
  if (!result.error) {
    lastStatus = typeof result.status === "number" ? result.status : 1;
    if (lastStatus === 0) process.exit(0);
  }
}

process.exit(lastStatus);
