#!/usr/bin/env node
/**
 * Fold the built catalogue into the plugin that ships with the desktop app, so
 * a machine that cannot reach the project domain still resolves models from the
 * same merged data instead of an older snapshot.
 *
 * Runs as part of `build:plugins` and stays silent when the catalogue is absent
 * (a checkout that has never run the daily job still builds).
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROM = path.join(ROOT, "dl", "capabilities.json");
const TO = path.join(ROOT, "desktop", "resources", "plugins", "model-vision", "data", "catalogue.json");

if (!existsSync(FROM)) {
  console.log("bundle-catalogue: dl/capabilities.json not present, keeping the committed snapshot");
  process.exit(0);
}
const doc = JSON.parse(readFileSync(FROM, "utf8"));
const keys = Object.keys(doc?.keys ?? {});
if (keys.length === 0) {
  console.error("bundle-catalogue: the catalogue has no keys — refusing to ship it");
  process.exit(1);
}
copyFileSync(FROM, TO);
console.log(`bundle-catalogue: bundled ${keys.length} keys (${(readFileSync(TO).length / 1024).toFixed(1)} KB)`);
