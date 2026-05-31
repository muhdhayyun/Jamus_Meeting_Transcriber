/**
 * Build whisper.cpp (the binary Jamus calls for transcription).
 *
 * On Windows this auto-locates the Visual Studio "vcvars64" environment so that
 * CMake + the MSVC compiler are on PATH, then runs the CMake build. On macOS/Linux
 * it just runs CMake directly (cc/clang assumed present).
 *
 * Run with:  npm run build:whisper
 */
import { spawnSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

function whisperRoot() {
  const pkg = require.resolve('nodejs-whisper/package.json');
  return path.join(path.dirname(pkg), 'cpp', 'whisper.cpp');
}

function findVcvars() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  );
  if (!fs.existsSync(vswhere)) return null;
  const out = execSync(
    `"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`,
    { encoding: 'utf8' }
  ).trim();
  if (!out) return null;
  const vcvars = path.join(out, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return fs.existsSync(vcvars) ? vcvars : null;
}

const root = whisperRoot();
console.log(`[build:whisper] whisper.cpp: ${root}`);

let result;
if (os.platform() === 'win32') {
  const vcvars = findVcvars();
  if (!vcvars) {
    console.error('[build:whisper] Could not find Visual Studio vcvars64.bat. Install the "Desktop development with C++" workload (VS Build Tools).');
    process.exit(1);
  }
  console.log(`[build:whisper] Using ${vcvars}`);
  // Write a temp .bat to avoid the nested-quote escaping problems of `cmd /c "..."`.
  const bat = path.join(os.tmpdir(), `jamus-build-whisper-${Date.now()}.bat`);
  fs.writeFileSync(
    bat,
    [
      '@echo off',
      `call "${vcvars}"`,
      `cd /d "${root}"`,
      'cmake -B build || exit /b 1',
      'cmake --build build --config Release || exit /b 1',
    ].join('\r\n'),
    'utf8'
  );
  result = spawnSync('cmd.exe', ['/c', bat], { stdio: 'inherit' });
  try { fs.unlinkSync(bat); } catch { /* ignore */ }
} else {
  result = spawnSync('sh', ['-c', `cd "${root}" && cmake -B build && cmake --build build --config Release`], { stdio: 'inherit' });
}

process.exit(result.status ?? 1);
