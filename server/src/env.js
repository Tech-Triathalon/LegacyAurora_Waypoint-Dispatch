// Zero-dependency .env loader (dotenv is not in the dependency tree).
// Loads server/.env then project-root/.env (root values never override
// already-set keys). Real environment variables always win.
const fs = require('fs');
const path = require('path');

function loadEnvFile(file, override = false) {
  try {
    if (!fs.existsSync(file)) return 0;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let loaded = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && (override || process.env[key] === undefined)) {
        process.env[key] = value;
        loaded += 1;
      }
    }
    return loaded;
  } catch {
    return 0;
  }
}

function loadEnv() {
  // Local dev: server/.env first (closest to the code), then the repo root copy.
  loadEnvFile(path.join(__dirname, '..', '.env'));
  loadEnvFile(path.join(__dirname, '..', '..', '.env'));
}

module.exports = { loadEnv, loadEnvFile };
