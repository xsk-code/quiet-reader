import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ArticleStore } from './lib/store.mjs';
import { parseImportInput } from './lib/import-input.mjs';
import { fetchArticleHTML, extractArticle } from './lib/article.mjs';
import { fetchXArticle } from './lib/xarticle.mjs';
import { translateArticle } from './lib/translate.mjs';
import { ImageQueue, loadImageCache, translateImage, articleImages } from './lib/images.mjs';
import { ModelSettings, loadEnvironment, validateBaseURL } from './lib/settings.mjs';
import { createModelRuntime } from './lib/providers.mjs';
import { languages, findLanguage, defaultLanguage } from './lib/languages.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
loadEnvironment(path.join(root, '.env'));
const store = new ArticleStore(path.resolve(process.env.READER_DATA_DIR || path.join(root, 'data')));
await mkdir(store.directory, { recursive: true, mode: 0o700 });
const lockfile = path.join(store.directory, '.lock');
async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await writeFile(lockfile, String(process.pid), { flag: 'wx', mode: 0o600 }); return; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockfile, 'utf8').catch(() => ''));
      if (pid && pid !== process.pid) {
        let alive = true;
        try { process.kill(pid, 0); } catch (probe) { alive = probe.code === 'EPERM'; }
        if (alive) { console.error('数据目录已被另一个拾页进程使用，请先停止它或更换 READER_DATA_DIR。'); process.exit(1); }
      }
      await rm(lockfile, { force: true });
    }
  }
  console.error('无法锁定数据目录，请检查 READER_DATA_DIR 权限。'); process.exit(1);
}
await acquireLock();
const releaseLock = () => rmSync(lockfile, { force: true });
process.on('exit', releaseLock);
await store.init();
const settings = await new ModelSettings(store.directory).init();
const runtime = createModelRuntime(settings);
const imageCache = await loadImageCache(store);
const imageQueue = new ImageQueue(store, { concurrency: Number(process.env.IMAGE_CONCURRENCY || 2),
  translate: async (item, directory, options) => translateImage(item, directory, { ...options, cache: imageCache, agent: runtime.run, imageProvider: await runtime.resolve(null, 'image') }) });
const environmentLanguage = process.env.READER_TARGET_LANGUAGE?.trim() || '';
if (environmentLanguage && !findLanguage(environmentLanguage)) {
  console.error(`READER_TARGET_LANGUAGE 不受支持，可用：${languages.map(language => language.code).join(', ')}。`); process.exit(1);
}

const jobs = new Map();
let queue = Promise.resolve();
let activeJobs = 0;
let probing = false;
const port = Number(process.env.PORT || 4317);
const host = '127.0.0.1';
const startedAt = new Date().toISOString();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function send(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
const statusByCode = { MODEL_NOT_CONFIGURED: 409, IMAGE_RATE_LIMIT: 429, MODEL_TIMEOUT: 504, MODEL_HTTP: 502, MODEL_CONNECTION: 502,
  MODEL_OUTPUT: 502, MODEL_INPUT: 400, IMAGE_VALIDATION: 422, IMAGE_DOWNLOAD: 502, IMAGE_AGENT: 502, IMAGE_PROCESSING: 500 };
function sendError(res, error) {
  const message = error.message || '处理失败，请重试。';
  const code = error.code || (/正在|请等待|已经在|请先完成|较多/.test(message) ? 'CONFLICT' : /不存在|没有找到/.test(message) ? 'NOT_FOUND' : 'BAD_REQUEST');
  const status = code === 'MODEL_HTTP' && error.status === 429 ? 429 : statusByCode[code] || (code === 'CONFLICT' ? 409 : code === 'NOT_FOUND' ? 404 : 400);
  send(res, status, { error: message, code, ...(Number.isInteger(error.status) ? { upstreamStatus: error.status } : {}) });
}
async function listModels(input) {
  const prefix = validateBaseURL(typeof input.baseURL === 'string' ? input.baseURL : '') || settings.current().apiBaseURL;
  if (!prefix) throw new Error('请先填写服务地址。');
  const key = (typeof input.apiKey === 'string' ? input.apiKey.trim() : '') || settings.key('text');
  if (key.length > 4096 || /[\r\n\x00]/.test(key)) throw new Error('密钥格式无效。');
  let response;
  try {
    response = await fetch(prefix + '/models', { redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  } catch (error) {
    if (error.name === 'TimeoutError') throw Object.assign(new Error('读取模型列表超时。'), { code: 'MODEL_TIMEOUT' });
    throw Object.assign(new Error('无法读取模型列表，请检查服务地址和网络。'), { code: 'MODEL_CONNECTION' });
  }
  if (!response.ok) {
    await response.body?.cancel();
    const message = response.status === 401 || response.status === 403 ? '模型服务拒绝访问，请检查密钥和模型权限。'
      : response.status === 404 ? '该服务没有 /models 接口，请手动填写模型名。' : `读取模型列表失败（HTTP ${response.status}）。`;
    throw Object.assign(new Error(message), { code: 'MODEL_HTTP', status: response.status });
  }
  const text = await response.text();
  if (text.length > 1_000_000) throw Object.assign(new Error('模型列表过大，请手动填写模型名。'), { code: 'MODEL_OUTPUT' });
  let data; try { data = JSON.parse(text); } catch { throw Object.assign(new Error('模型列表格式无效，请手动填写模型名。'), { code: 'MODEL_OUTPUT' }); }
  const items = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const models = [...new Set(items.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))].slice(0, 200);
  if (!models.length) throw new Error('服务没有返回可用模型，请手动填写模型名。');
  return models;
}
async function setupReport() {
  return { ...await runtime.describe(), targetLanguage: environmentLanguage || null, languages: languages.map(({ code, label }) => ({ code, label })) };
}
function targetLanguage(input) {
  if (input.targetLanguage === undefined || input.targetLanguage === null || input.targetLanguage === '') return environmentLanguage || defaultLanguage;
  if (!findLanguage(input.targetLanguage)) throw new Error('不支持的目标语言。');
  return input.targetLanguage;
}
const localOrigins = [`http://${host}:${port}`, `http://localhost:${port}`];
// The browser extension is the only cross-origin caller we accept, and only to
// hand over one URL. Everything else stays same-origin.
const extensionOrigin = value => typeof value === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(value);
const extensionRequest = (pathname, method) => method === 'POST' && pathname === '/api/import';
async function health() {
  const report = await runtime.describe();
  return { ok: true, application: 'shiye', version, projectDirectory: root, dataDirectory: store.directory,
    textReady: report.textReady, imageReady: report.imageReady, textProvider: report.textProvider,
    imageProvider: report.imageProvider, startedAt };
}
async function body(req) {
  let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 160_000) throw new Error('输入内容过长，请分段导入。'); }
  try {
    const input = value ? JSON.parse(value) : {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input;
  } catch { throw new Error('提交的数据格式不正确。'); }
}
function enqueue(work) {
  if (activeJobs >= 8) throw new Error('等待中的文章较多，请等当前任务结束后再导入。');
  const job = { id: randomUUID(), status: 'queued', stage: 'queued', message: '等待处理…', progress: 0, articleId: null };
  jobs.set(job.id, job); activeJobs++;
  const task = queue.then(async () => {
    job.status = 'running';
    try { await work(job); job.status = 'done'; job.stage = 'complete'; job.progress = 100; job.message = '译文已保存，开始阅读吧。'; }
    catch (error) {
      const fetching = job.stage === 'fetching' || job.stage === 'extracting';
      job.status = 'error'; job.message = fetching ? `正文获取失败，尚未调用模型：${error.message}` : error.message;
      if (error.code) job.code = error.code;
      // Lets the page offer "open the original, copy, paste" instead of a dead end.
      if (fetching) job.fetchFailed = true;
      if (job.articleId) await store.update(job.articleId, { status: 'error', error: error.message }).catch(() => {});
    } finally { activeJobs--; }
  });
  queue = task.catch(() => {});
  // Retain current jobs and the most recent 100 completed jobs.
  const completed = [...jobs.values()].filter(j => ['done', 'error'].includes(j.status));
  for (const old of completed.slice(0, Math.max(0, completed.length - 100))) jobs.delete(old.id);
  return job;
}
async function translate(job, article, provider, language) {
  job.articleId = article.id;
  job.stage = 'translating';
  await store.update(article.id, { status: 'translating', error: '', provider });
  const name = provider === 'api' ? '模型服务' : provider === 'codex' ? 'Codex' : 'agy';
  const translated = await translateArticle(article, provider, path.join(store.directory, 'agent-workspace'), (index, total, event) => {
    const part = `第 ${index + 1} / ${total} 段`;
    job.message = event.state === 'retrying' ? `${part}请求失败，${Math.round(event.delay / 1000)} 秒后自动重试（${event.attempt} / ${event.retries}）`
      : `${event.state === 'running' ? `${name} 正在生成译文` : `正在连接 ${name}`} · ${part}`;
    if (event.pid) job.agentPid = event.pid;
    job.progress = 20 + Math.round(index / total * 75);
  }, runtime.run, {
    language, draft: article.translationDraft,
    // Save each finished chunk so a later failure or restart resumes instead of paying again.
    onChunk: draft => store.update(article.id, { translationDraft: draft }),
  });
  await store.update(article.id, { translated, status: 'ready', translatedAt: new Date().toISOString(), targetLanguage: language, translationDraft: null });
  if (!articleImages(article.original).length) {
    await store.update(article.id, { imageTranslation: { status: 'done', items: [] } }); return;
  }
  const capabilities = await runtime.describe();
  if (!capabilities.imageReady) {
    await store.update(article.id, { imageTranslation: { status: 'disabled', items: [], reason: capabilities.imageProvider === 'none' ? '图片重绘未启用，已保留原图。' : '图片接入尚未配置完成，已保留原图。' } }); return;
  }
  await imageQueue.start(article.id).catch(async () => {
    await store.update(article.id, { imageTranslation: { status: 'error', items: [], error: '图片任务未能启动，可以单独重试。' } });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  try {
    // Local-only API: reject DNS rebinding hosts and cross-origin browser requests.
    const expectedHost = `${host}:${port}`;
    if (![expectedHost, `localhost:${port}`].includes(req.headers.host)) { send(res, 403, { error: '不允许的访问地址。', code: 'FORBIDDEN' }); return; }
    const url = new URL(req.url, `http://${expectedHost}`);
    const origin = req.headers.origin;
    const fromExtension = extensionOrigin(origin);
    if (req.method === 'OPTIONS') {
      // JSON is used so the extension preflights; answer only its handoff routes.
      if (!fromExtension || !extensionRequest(url.pathname, String(req.headers['access-control-request-method'] || '').toUpperCase())) {
        send(res, 403, { error: '不允许跨站请求。', code: 'FORBIDDEN' }); return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin',
      });
      res.end(); return;
    }
    if (origin && !localOrigins.includes(origin) && !fromExtension) { send(res, 403, { error: '不允许跨站请求。', code: 'FORBIDDEN' }); return; }
    if (fromExtension && !extensionRequest(url.pathname, req.method)) { send(res, 403, { error: '扩展只能导入文章。', code: 'FORBIDDEN' }); return; }
    if (fromExtension) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/api/health' && req.method === 'GET') { send(res, 200, await health()); return; }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      send(res, 200, { ...await health(), activeJobs, imageConcurrency: imageQueue.concurrency, activeImages: imageQueue.running, queuedImages: imageQueue.waiting.length }); return;
    }
    if (url.pathname === '/api/setup' && req.method === 'GET') { send(res, 200, await setupReport()); return; }
    if (url.pathname === '/api/setup' && req.method === 'PUT') {
      if (activeJobs || imageQueue.active.size || probing) throw new Error('请等待当前翻译、图片任务和连接验证完成后修改接入配置。');
      const input = await body(req);
      const { apiKey, imageApiKey, ...config } = input;
      await settings.save(config);
      const keys = {};
      if (Object.hasOwn(input, 'apiKey')) keys.apiKey = apiKey;
      if (Object.hasOwn(input, 'imageApiKey')) keys.imageApiKey = imageApiKey;
      if (Object.keys(keys).length) await settings.saveKeys(keys);
      await runtime.refresh(); send(res, 200, await setupReport()); return;
    }
    if (url.pathname === '/api/setup/models' && req.method === 'POST') {
      if (probing) throw new Error('正在验证连接，请稍后。');
      const input = await body(req); probing = true;
      try { send(res, 200, { models: await listModels(input) }); } finally { probing = false; }
      return;
    }
    if (url.pathname === '/api/setup/probe' && req.method === 'POST') {
      if (probing || activeJobs || imageQueue.active.size) throw new Error('请等待当前任务完成后验证连接。');
      const input = await body(req); probing = true;
      try { send(res, 200, await runtime.probe(input.kind)); } finally { probing = false; }
      return;
    }
    if (url.pathname === '/api/articles' && req.method === 'GET') { send(res, 200, store.list()); return; }
    if (url.pathname === '/api/import' && req.method === 'POST') {
      if (probing) throw new Error('正在验证连接，请稍后开始翻译。');
      const input = await body(req);
      if (Object.hasOwn(input, 'content')) Object.assign(input, parseImportInput(input.content));
      const provider = await runtime.resolve(input.provider);
      const language = targetLanguage(input);
      if (input.markdown !== undefined && (typeof input.markdown !== 'string' || input.markdown.trim().length < 30)) throw new Error('请粘贴至少 30 个字符的正文或 Markdown。');
      if (input.markdown?.length > 120_000) throw new Error('正文超过 12 万字符，请分段导入。');
      if (!input.markdown && typeof input.url !== 'string') throw new Error('请填写文章链接。');
      const job = enqueue(async job => {
        job.stage = 'fetching'; if (!input.markdown) job.sourceURL = input.url;
        job.message = '正在提取文章正文…'; job.progress = 8;
        let value;
        if (input.markdown) value = { title: String(input.title || '导入的文章').slice(0, 250), original: input.markdown.trim(), sourceURL: '', siteName: '粘贴导入', author: '' };
        else {
          try {
            const page = await fetchArticleHTML(input.url);
            job.stage = 'extracting';
            value = extractArticle(page.html, page.url);
          } catch (error) {
            // X keeps long-form bodies behind a login; the open FxTwitter API
            // republishes them without any account.
            if (error.code !== 'X_LOGIN_REQUIRED') throw error;
            job.message = '正在通过公开接口读取 X 内容…';
            value = await fetchXArticle(input.url);
            job.stage = 'extracting';
          }
        }
        const article = await store.add(value);
        await translate(job, article, provider, language);
      });
      send(res, 202, job); return;
    }
    if (parts[0] === 'api' && parts[1] === 'jobs' && parts.length === 3 && req.method === 'GET') {
      const job = jobs.get(parts[2]); send(res, job ? 200 : 404, job || { error: '任务不存在，可能已重启。请查看文章库。' }); return;
    }
    if (parts[0] === 'api' && parts[1] === 'articles' && parts.length >= 3) {
      if (parts[3] === 'restore' && parts.length === 4 && req.method === 'POST') {
        send(res, 200, await store.restore(parts[2])); return;
      }
      const article = store.get(parts[2]);
      if (!article) { send(res, 404, { error: '文章不存在。', code: 'NOT_FOUND' }); return; }
      if (parts.length === 3 && req.method === 'DELETE') {
        if (article.status === 'translating' || [...jobs.values()].some(job => job.articleId === article.id && ['queued', 'running'].includes(job.status))) {
          send(res, 409, { error: '文章正在翻译，请完成后再删除。', code: 'CONFLICT' }); return;
        }
        const removed = await store.remove(article.id);
        send(res, 200, { id: removed.id, deletedAt: removed.deletedAt }); return;
      }
      if (parts.length === 3 && req.method === 'PATCH') {
        const input = await body(req);
        if (Object.hasOwn(input, 'reading')) {
          send(res, 200, await store.updateReading(article.id, input.reading)); return;
        }
        if (typeof input.starred !== 'boolean') throw new Error('收藏状态无效。');
        send(res, 200, await store.update(article.id, { starred: input.starred })); return;
      }
      if (parts[3] === 'translate' && parts.length === 4 && req.method === 'POST') {
        const input = await body(req);
        const provider = await runtime.resolve(input.provider);
        const language = targetLanguage(input);
        if (article.status === 'translating' || [...jobs.values()].some(j => j.articleId === article.id && ['queued', 'running'].includes(j.status))) throw new Error('这篇文章已经在翻译中。');
        if (imageQueue.active.has(article.id)) throw new Error('图片正在翻译，请完成后再重译正文。');
        const job = enqueue(job => translate(job, article, provider, language));
        job.articleId = article.id;
        send(res, 202, job); return;
      }
      if (parts[3] === 'images' && parts.length === 4 && req.method === 'POST') {
        if (article.status === 'translating') throw new Error('请先完成正文翻译。');
        if (await runtime.resolve(null, 'image') === 'none') throw new Error('图片重绘未启用，请在模型接入中配置。');
        const input = await body(req);
        send(res, 202, await imageQueue.start(article.id, { retry: true, redraw: input.redraw === true })); return;
      }
    }
    if (url.pathname.startsWith('/api/')) { send(res, 404, { error: '接口不存在。', code: 'NOT_FOUND' }); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { send(res, 405, { error: '不支持的操作。', code: 'METHOD_NOT_ALLOWED' }); return; }
    if (parts[0] === 'media' && parts.length === 4) {
      const article = store.get(parts[1]);
      const item = article?.imageTranslation?.items?.find(item => item.status === 'done' && item.url === url.pathname);
      if (!item || !/^translated\.(png|jpg|gif|webp|avif|svg)$/.test(parts[3])) { res.writeHead(404); res.end('Not found'); return; }
      const buffer = await readFile(path.join(store.directory, 'articles', article.id, 'images', item.id, parts[3]));
      const format = path.extname(parts[3]).slice(1);
      res.writeHead(200, { 'Content-Type': format === 'svg' ? 'image/svg+xml' : `image/${format === 'jpg' ? 'jpeg' : format}`, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buffer); return;
    }
    const files = {
      '/': 'public/index.html', '/app.js': 'public/app.js', '/style.css': 'public/style.css',
      '/reading.css': 'public/reading.css', '/newsprint.css': 'public/reading.css',
      '/image-insights.mjs': 'lib/image-insights.mjs',
      '/image-scene.mjs': 'lib/image-scene.mjs',
      '/languages.mjs': 'lib/languages.mjs',
      '/fonts/pt-serif/pt-serif-v19-latin-regular.woff2': 'public/fonts/pt-serif/pt-serif-v19-latin-regular.woff2',
      '/fonts/pt-serif/pt-serif-v19-latin-italic.woff2': 'public/fonts/pt-serif/pt-serif-v19-latin-italic.woff2',
      '/fonts/pt-serif/pt-serif-v19-latin-700.woff2': 'public/fonts/pt-serif/pt-serif-v19-latin-700.woff2',
      '/fonts/pt-serif/pt-serif-v19-latin-700italic.woff2': 'public/fonts/pt-serif/pt-serif-v19-latin-700italic.woff2',
      '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js',
      '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js',
    };
    const file = files[url.pathname];
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    const buffer = await readFile(path.join(root, file));
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buffer);
  } catch (error) { sendError(res, error); }
});
server.on('error', error => { releaseLock(); console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请使用 PORT=4318 npm start。` : '服务启动失败，请检查端口和权限。'); process.exitCode = 1; });
server.listen(port, host, () => console.log(`拾页已启动：http://${host}:${port}\n文章保存在 ${store.directory}。按 Ctrl+C 停止。`));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => { releaseLock(); process.exit(0); });
  server.closeIdleConnections?.();
  setTimeout(() => { releaseLock(); process.exit(0); }, 5000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
