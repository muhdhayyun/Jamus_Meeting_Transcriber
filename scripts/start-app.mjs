// Launch the Electron app with a clean environment.
//
// Some shells (notably the VS Code integrated terminal) set ELECTRON_RUN_AS_NODE=1,
// which makes electron.exe behave as plain Node and breaks the GUI. We strip it here
// so `npm run app` works from any terminal.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // path to the electron binary
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.join(__dirname, '..', 'electron', 'main.cjs');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [mainEntry], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
