import { existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (!existsSync('dist/index.js')) {
  const build = spawnSync(npm, ['run', 'build'], { stdio: 'inherit', shell: false });
  if (build.status !== 0) process.exit(build.status || 1);
}
const child = spawn(process.execPath, ['src/index.ts'], { stdio: 'inherit', env: process.env });
child.on('exit', code => process.exit(code ?? 0));
child.on('error', err => { console.error(err); process.exit(1); });
