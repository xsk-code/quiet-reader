import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEnvironment } from '../lib/settings.mjs';
import { openBrowser } from './open-browser.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (Number(process.versions.node.split('.')[0]) < 22) { console.error('需要 Node.js 22 或更新版本。'); process.exit(1); }
loadEnvironment(path.join(root, '.env'));
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT 必须是 1 至 65535 的整数。'); process.exit(1); }
const url = `http://127.0.0.1:${port}`;
const healthy = async () => {
  try { const response = await fetch(url + '/api/status', { signal: AbortSignal.timeout(1000) }); const status = await response.json(); return response.ok && status.application === 'shiye' && status.projectDirectory === root; }
  catch { return false; }
};
const open = () => { console.log(`阅读地址：${url}`); openBrowser(url); };
if (await healthy()) { open(); } else {
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, stdio: 'inherit', env: process.env });
  let ended = false;
  const finished = new Promise(resolve => {
    child.once('error', () => { ended = true; console.error('服务无法启动，请运行 npm run doctor 检查。'); process.exitCode = 1; resolve(); });
    child.once('exit', code => { ended = true; process.exitCode ||= code || 0; resolve(); });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  process.on('exit', () => { if (!ended) child.kill('SIGTERM'); });
  let ready = false;
  for (let index = 0; index < 40 && !ended; index++) {
    if (await healthy()) { ready = true; open(); break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready && !ended) { console.error('服务未能就绪，请检查端口和依赖。'); process.exitCode = 1; child.kill('SIGTERM'); }
  await finished;
}
