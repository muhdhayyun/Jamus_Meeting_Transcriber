/**
 * Build whisper.cpp (the binary Jamus calls for transcription).
 *
 * On Windows this auto-locates the Visual Studio "vcvars64" environment so that
 * CMake + the MSVC compiler are on PATH, then runs the CMake build. On macOS/Linux
 * it just runs CMake directly (cc/clang assumed present).
 *
 * Run with:  npm run build:whisper
 * GPU build:  JAMUS_BUILD_CUDA=1 npm run build:whisper   (or pass --cuda)
 *             Requires the NVIDIA CUDA Toolkit. Builds whisper.cpp with cuBLAS.
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

/** Locate the newest installed CUDA Toolkit, or null. */
function findCuda() {
  if (process.env.CUDA_PATH && fs.existsSync(process.env.CUDA_PATH)) return process.env.CUDA_PATH;
  const base = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
  if (!fs.existsSync(base)) return null;
  const versions = fs.readdirSync(base).filter((d) => /^v\d/.test(d)).sort().reverse();
  return versions.length ? path.join(base, versions[0]) : null;
}

const useCuda = process.env.JAMUS_BUILD_CUDA === '1' || process.argv.includes('--cuda');
const root = whisperRoot();
console.log(`[build:whisper] whisper.cpp: ${root}`);
console.log(`[build:whisper] CUDA build: ${useCuda ? 'ENABLED' : 'disabled (CPU)'}`);

let result;
if (os.platform() === 'win32') {
  const vcvars = findVcvars();
  if (!vcvars) {
    console.error('[build:whisper] Could not find Visual Studio vcvars64.bat. Install the "Desktop development with C++" workload (VS Build Tools).');
    process.exit(1);
  }
  console.log(`[build:whisper] Using ${vcvars}`);

  let cmakeFlags = '';
  let cudaSetup = '';
  if (useCuda) {
    const cuda = findCuda();
    if (!cuda) {
      console.error('[build:whisper] CUDA build requested but no CUDA Toolkit found. Install it or unset JAMUS_BUILD_CUDA.');
      process.exit(1);
    }
    console.log(`[build:whisper] CUDA Toolkit: ${cuda}`);
    // MSBuild's "CUDA <ver>.targets" resolves CudaToolkitDir from the version-specific
    // env var (e.g. CUDA_PATH_V12_8). Set both that and CUDA_PATH for the build shell.
    const ver = path.basename(cuda).replace(/^v/i, ''); // "12.8"
    const verVar = `CUDA_PATH_V${ver.replace(/\./g, '_')}`; // CUDA_PATH_V12_8
    // CMAKE_CUDA_ARCHITECTURES=89 targets Ada (RTX 40-series) for a fast, lean build.
    cmakeFlags = `-DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES=89 "-DCUDAToolkit_ROOT=${cuda}" "-DCMAKE_CUDA_COMPILER=${cuda}\\bin\\nvcc.exe"`;
    cudaSetup = [
      `set "CUDA_PATH=${cuda}"`,
      `set "${verVar}=${cuda}"`,
      `set "CudaToolkitDir=${cuda}"`,
      `set "PATH=${cuda}\\bin;%PATH%"`,
    ].join('\r\n');
  }

  // Write a temp .bat to avoid the nested-quote escaping problems of `cmd /c "..."`.
  // Wipe the build dir so a CPU<->CUDA switch reconfigures cleanly.
  const bat = path.join(os.tmpdir(), `jamus-build-whisper-${Date.now()}.bat`);
  fs.writeFileSync(
    bat,
    [
      '@echo off',
      `call "${vcvars}"`,
      cudaSetup,
      `cd /d "${root}"`,
      'if exist build rmdir /s /q build',
      `cmake -B build ${cmakeFlags} || exit /b 1`,
      'cmake --build build --config Release || exit /b 1',
    ].filter(Boolean).join('\r\n'),
    'utf8'
  );
  result = spawnSync('cmd.exe', ['/c', bat], { stdio: 'inherit' });
  try { fs.unlinkSync(bat); } catch { /* ignore */ }

  // The CUDA binary needs cuBLAS/cudart DLLs at runtime. Copy them next to whisper-cli.exe
  // so transcription works regardless of the user's PATH.
  if (useCuda && (result.status ?? 0) === 0) {
    const cuda = findCuda();
    const relDir = path.join(root, 'build', 'bin', 'Release');
    if (cuda && fs.existsSync(relDir)) {
      const cudaBin = path.join(cuda, 'bin');
      const wanted = fs.existsSync(cudaBin) ? fs.readdirSync(cudaBin) : [];
      for (const dll of wanted) {
        if (/^(cublas64|cublasLt64|cudart64)_\d+\.dll$/i.test(dll)) {
          try { fs.copyFileSync(path.join(cudaBin, dll), path.join(relDir, dll)); console.log(`[build:whisper] bundled ${dll}`); } catch { /* ignore */ }
        }
      }
    }
  }
} else {
  const flags = useCuda ? '-DGGML_CUDA=1' : '';
  result = spawnSync('sh', ['-c', `cd "${root}" && rm -rf build && cmake -B build ${flags} && cmake --build build --config Release`], { stdio: 'inherit' });
}

process.exit(result.status ?? 1);
