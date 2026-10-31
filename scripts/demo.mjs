import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './open-browser.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const verify = process.argv.includes('--verify');
const sample = await readFile(path.join(root, 'examples/sample.md'), 'utf8');
const reply = '# 演示文章\n\n这是一篇由本地模拟服务生成的演示译文，不会发送到外部网络。\n\n## 开始阅读\n\n- 译文、原文和对照模式可切换；导入栏「译为」可选择目标语言。\n- 关闭终端后演示数据会被删除。\n';
const mock = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const prompt = JSON.parse(body).messages?.[0]?.content;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: /connection test/i.test(prompt) ? 'OK' : reply }, finish_reason: 'stop' }] }));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function waitFor(url, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(500) }); if (response.ok) return await response.json(); } catch {}
    await sleep(100);
  }
  throw new Error('服务未能启动，请检查 Node.js 版本和端口。');
}
async function json(url, options) {
  const response = await fetch(url, options), value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败（HTTP ${response.status}）。`);
  return value;
}
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
const mockPort = mock.address().port, port = await freePort(), data = await mkdtemp(path.join(os.tmpdir(), 'quiet-reader-demo-'));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), READER_DATA_DIR: data, READER_TEXT_PROVIDER: 'api',
  READER_API_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, READER_TEXT_MODEL: 'demo', READER_IMAGE_PROVIDER: 'none',
  READER_API_KEY: '', READER_IMAGE_API_KEY: '', READER_IMAGE_API_BASE_URL: '', READER_IMAGE_MODEL: '',
  AGY_BIN: path.join(data, 'no-agy'), CODEX_BIN: path.join(data, 'no-codex') };
const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: verify ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
const output = [];
if (verify) { child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk)); }
let stopping = false, cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  if (child.exitCode === null) child.kill('SIGTERM');
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), sleep(3000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), sleep(1000)]); }
  await new Promise(resolve => mock.close(resolve));
  await rm(data, { recursive: true, force: true }).catch(() => {});
}
async function stop(code) { if (stopping) return; stopping = true; try { await cleanup(); } finally { process.exit(code); } }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
child.on('exit', code => { if (!stopping) stop(code ?? 1); });
try {
  const health = await waitFor(`${base}/api/health`);
  if (!health.textReady) throw new Error('演示模型尚未就绪。');
  const job = await json(`${base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: sample, provider: 'api' }) });
  let state;
  for (let index = 0; index < 150; index++) { state = await json(`${base}/api/jobs/${job.id}`); if (['done', 'error'].includes(state.status)) break; await sleep(100); }
  if (state?.status !== 'done') throw new Error(state?.message || '演示翻译超时。');
  if (verify) {
    const article = (await json(`${base}/api/articles`)).find(value => value.translated?.includes('演示译文'));
    if (!article) throw new Error('演示文章没有生成译文。');
    const result = { ok: true, url: base, articleId: article.id, version: health.version };
    stopping = true; await cleanup();
    console.log(JSON.stringify(result, null, 2)); process.exit(0);
  } else {
    console.log(`演示地址：${base}\n演示数据：${data}\n按 Ctrl+C 停止。`);
    openBrowser(base);
  }
} catch (error) {
  console.error(error.message);
  if (verify && output.length) console.error(Buffer.concat(output).toString('utf8').slice(-2000));
  await stop(1);
}
