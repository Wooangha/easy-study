#!/usr/bin/env node
// Compiles the server (server/, shared/) to plain JavaScript in dist-server/ with tsc (tsconfig.build.json).
// Production runs `node dist-server/server/index.js`, which needs no TypeScript support from Node and keeps
// Node's TypeScript stripper out of memory (DESIGN §15). `npm run dev` and the tests keep running the .ts sources.
//
//   node scripts/build-server.mjs [--out <dir>]    (default <repo>/dist-server; the directory is replaced)
//
// The output must stay inside the repository: the compiled server finds the repository root (web/dist, the
// default library) by looking for package.json upwards, and its packages in <repo>/node_modules.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0 && args[outFlag + 1] ? path.resolve(args[outFlag + 1]) : path.join(root, 'dist-server');

// Stale files of modules that no longer exist must not linger.
rmSync(outDir, { recursive: true, force: true });
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
try {
  execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json'), '--outDir', outDir], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  console.error('\nserver build failed: fix the TypeScript errors above (npm run typecheck).');
  process.exit(1);
}
// Entry points started by path: the server, the Linux server CLI (bin/easy-study, DESIGN §26), the image worker (child
// process), the slide aligner (worker thread), the desktop app's loopback proxy (its own process, DESIGN §19).
for (const entry of ['server/index.js', 'server/cli.js', 'server/imageWorker.js', 'server/recordings/align/worker.js', 'server/proxy.js']) {
  if (!existsSync(path.join(outDir, entry))) {
    console.error(`server build failed: ${path.join(outDir, entry)} was not written.`);
    process.exit(1);
  }
}
console.log(`server built → ${path.relative(root, outDir) || outDir}`);
