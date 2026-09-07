// Execute the characterization against recorded, unchanged core source, never the working core.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'b39cc8f9cb599f2550dc177a98f9f26eeae1d3b1';
const temp = mkdtempSync(join(tmpdir(), 'mse-v03-'));
try {
  for (const file of ['package.json', 'src/core/types.ts', 'src/core/validate.ts', 'src/core/reference-provider.ts']) {
    mkdirSync(dirname(join(temp, file)), { recursive: true });
    writeFileSync(join(temp, file), execFileSync('git', ['show', `${base}:${file}`], { cwd: root }));
  }
  for (const file of ['test/bindings/merchant-batch.ts', 'test/baseline/request-reporting.case.ts']) {
    const target = join(temp, file.replace('.case.ts', '.test.ts'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
  execFileSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run'], { cwd: temp, stdio: 'inherit' });
} finally { rmSync(temp, { recursive: true, force: true }); }
