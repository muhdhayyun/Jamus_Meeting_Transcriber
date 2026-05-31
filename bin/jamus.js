#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv).catch((err) => {
  // Top-level safety net: print a clean message instead of a raw stack trace.
  console.error(`\n[31m✖ ${err?.message ?? err}[0m`);
  if (process.env.JAMUS_DEBUG) console.error(err);
  process.exit(1);
});
