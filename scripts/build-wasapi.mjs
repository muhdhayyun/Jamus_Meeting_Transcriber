/**
 * Compile the WASAPI loopback recorder (Windows only) using the .NET Framework
 * csc.exe that ships with Windows — no NuGet / SDK required.
 *
 * Run with:  npm run build:wasapi   (no-op on non-Windows)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

if (os.platform() !== 'win32') {
  console.log('[build:wasapi] Not Windows — skipping (WASAPI loopback is Windows-only).');
  process.exit(0);
}

const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) {
  console.error(`[build:wasapi] csc.exe not found at ${csc}. Is the .NET Framework installed?`);
  process.exit(1);
}

const src = path.join(root, 'native', 'WasapiLoopbackRecorder.cs');
const out = path.join(root, 'native', 'wasapi-loopback.exe');

console.log(`[build:wasapi] Compiling ${path.relative(root, src)} -> ${path.relative(root, out)}`);
const res = spawnSync(
  csc,
  ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${out}`, src],
  { stdio: 'inherit' }
);
if (res.status !== 0 || !fs.existsSync(out)) {
  console.error('[build:wasapi] Compilation failed.');
  process.exit(res.status || 1);
}
console.log('[build:wasapi] Done.');
