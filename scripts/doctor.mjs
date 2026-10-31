import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ModelSettings, loadEnvironment } from '../lib/settings.mjs';
import { createModelRuntime } from '../lib/providers.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const json = process.argv.includes('--json'), probe = process.argv.includes('--probe'), requireModel = process.argv.includes('--require-model');
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const checks = [];
let modelRequestsSent = 0, ready = false, port, concurrency;
let directory = path.resolve(process.env.READER_DATA_DIR || path.join(root, 'data'));
const add = (name, status, message) => checks.push({ name, status, message });
try {
  const nodeReady = Number(process.versions.node.split('.')[0]) >= 22;
  add('node', nodeReady ? 'ok' : 'error', `Node.js ${process.versions.node}${nodeReady ? '' : '；需要 22 或更新版本'}`);
  loadEnvironment(path.join(root, '.env'));
  directory = path.resolve(process.env.READER_DATA_DIR || path.join(root, 'data'));
  port = Number(process.env.PORT || 4317); concurrency = Number(process.env.IMAGE_CONCURRENCY || 2);
  for (const dependency of ['marked', 'jsdom', '@mozilla/readability', 'dompurify', 'turndown', 'turndown-plugin-gfm']) {
    try { await access(path.join(root, 'node_modules', dependency, 'package.json')); }
    catch { add('dependencies', 'error', '依赖未安装，请运行 npm ci。'); break; }
  }
  if (!checks.some(check => check.name === 'dependencies')) add('dependencies', 'ok', '项目依赖已安装。');
  const settings = await new ModelSettings(directory).init();
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `.doctor-${randomUUID()}`);
    await writeFile(filename, '', { mode: 0o600 }); await unlink(filename);
    add('storage', 'ok', '数据目录可写。');
  } catch { add('storage', 'error', '数据目录不可写，请检查 READER_DATA_DIR 和目录权限。'); }
  const runtime = createModelRuntime(settings), report = await runtime.describe();
  ready = report.textReady;
  add('text', ready ? 'ok' : 'warning', ready ? `正文接入：${report.textProvider}；配置有效，登录和模型权限尚未验证。` : '正文接入尚未配置；这是设置项，不是安装错误。配置后重试，或运行 npm run demo 先体验。');
  add('image', report.imageReady ? 'ok' : 'warning', report.imageReady ? `图片接入：${report.imageProvider}；配置有效，视觉权限尚未验证。` : report.imageProvider === 'none' ? '图片重绘已关闭；正文可用时仍可阅读，图片保留原图。' : '图片接入尚未就绪；正文可用时仍可阅读，图片保留原图。');
  add('port', Number.isInteger(port) && port > 0 && port <= 65535 ? 'ok' : 'error', Number.isInteger(port) && port > 0 && port <= 65535 ? `服务将使用本机端口 ${port}；启动后通过 /api/health 核对服务。` : 'PORT 必须是 1 至 65535 的整数。');
  add('imageConcurrency', Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4 ? 'ok' : 'error', Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4 ? `图片并发数：${concurrency}。` : 'IMAGE_CONCURRENCY 必须是 1 至 4 的整数。');
  if (requireModel && !ready) add('model', 'error', '正文接入未配置；--require-model 要求先完成配置。');
  if (probe && !ready) add('probe', 'error', '正文接入未配置，无法验证连接。');
  if (probe) for (const kind of ['text', 'image']) {
    if (!(kind === 'text' ? report.textReady : report.imageReady)) continue;
    try { modelRequestsSent++; const result = await runtime.probe(kind); add(`${kind}Connection`, 'ok', result.message); }
    catch (error) { add(`${kind}Connection`, 'error', error.message); }
  }
} catch (error) { add('configuration', 'error', error.message); }
const ok = checks.every(check => check.status !== 'error');
if (json) console.log(JSON.stringify({ ok, ready, requireModel, version, node: process.versions.node, platform: process.platform, dataDirectory: directory, port, imageConcurrency: concurrency, modelRequestsSent, checks }, null, 2));
else {
  console.log(`拾页环境检查（${version}）`);
  for (const check of checks) console.log(`${{ ok: '✓', warning: '·', error: '✗' }[check.status]} ${check.message}`);
  console.log(!ok ? '安装检查未通过，请先处理上面的错误。'
    : !ready ? '安装检查通过；正文接入尚未配置，配置后运行 npm run doctor -- --require-model。'
    : probe ? '已按要求验证可用接入的连接。' : '安装与正文接入检查通过；未向模型发送请求，需要验证登录和权限时运行 npm run doctor -- --probe。');
}
process.exitCode = ok && (!requireModel || ready) ? 0 : 1;
