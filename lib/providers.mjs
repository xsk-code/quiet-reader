import path from 'node:path';
import os from 'node:os';
import { access, stat, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { runAgent } from './agents.mjs';

export async function commandAvailable(command, env = process.env, platform = process.platform) {
  if (typeof command !== 'string' || !command) return false;
  const windows = platform === 'win32';
  const extensions = windows
    ? /\.[^\\/]+$/.test(command) ? [''] : (env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const directories = command.includes('/') || command.includes('\\') ? [''] : (env.PATH || '').split(windows ? ';' : path.delimiter);
  for (const directory of directories) for (const extension of extensions) {
    try {
      const filename = path.resolve(directory, command + extension);
      await access(filename, windows ? constants.F_OK : constants.X_OK);
      // .cmd/.bat shims cannot be spawned safely with untrusted prompt arguments on Windows.
      if ((await stat(filename)).isFile() && !(windows && /\.(?:cmd|bat)$/i.test(filename))) return true;
    } catch {}
  }
  return false;
}

export async function callCompletion({ baseURL, model, key = '', prompt, imageData, timeout = 240_000, fetcher = fetch, onStarted = () => {} }) {
  const content = imageData ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageData } }] : prompt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    onStarted({ provider: 'api' });
    const response = await fetcher(baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 401 || response.status === 403 ? '模型服务拒绝访问，请检查环境变量中的密钥和模型权限。'
        : response.status === 429 ? '模型服务额度或调用频率受限（429），请稍后重试。' : `模型服务请求失败（HTTP ${response.status}），请检查地址和模型配置。`;
      throw Object.assign(new Error(message), { code: response.status === 429 && imageData ? 'IMAGE_RATE_LIMIT' : 'MODEL_HTTP', status: response.status });
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4_000_000) throw Object.assign(new Error('模型返回内容过大，请更换模型或分段处理。'), { code: 'MODEL_OUTPUT' });
      chunks.push(chunk);
    }
    let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('模型服务返回的数据格式无效。'), { code: 'MODEL_OUTPUT' }); }
    const choice = result.choices?.[0];
    if (choice?.finish_reason === 'length') throw Object.assign(new Error('模型输出被截断，请检查服务的输出长度限制。'), { code: 'MODEL_OUTPUT' });
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim() || choice?.message?.tool_calls?.length) throw Object.assign(new Error('模型未返回可用文字，请检查模型是否支持此任务。'), { code: 'MODEL_OUTPUT' });
    return text.trim();
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error('模型服务响应超时，原文已保留，可以重试。'), { code: 'MODEL_TIMEOUT' });
    if (/^(?:MODEL_|IMAGE_RATE_LIMIT)/.test(error.code || '')) throw error;
    // Never forward service error bodies or transport errors that may contain credentials.
    throw Object.assign(new Error('无法连接模型服务，请检查服务地址、网络和证书。'), { code: 'MODEL_CONNECTION' });
  } finally { clearTimeout(timer); }
}

export function createModelRuntime(settings, { env = settings.env, agent = runAgent, fetcher = fetch, findCommand = commandAvailable } = {}) {
  let cached, checkedAt = 0;
  const commands = async (refresh = false) => {
    if (refresh || !cached || Date.now() - checkedAt > 5000) {
      const [agy, codex] = await Promise.all([findCommand(env.AGY_BIN || 'agy', env), findCommand(env.CODEX_BIN || 'codex', env)]);
      cached = { agy, codex }; checkedAt = Date.now();
    }
    return cached;
  };
  const describe = async () => {
    const value = settings.current(), local = await commands();
    const textAPI = Boolean(value.apiBaseURL && value.textModel), imageAPI = Boolean((value.imageApiBaseURL || value.apiBaseURL) && (value.imageModel || value.textModel));
    const textProvider = value.textProvider;
    const imageProvider = value.imageProvider;
    return { settings: settings.public(), textProvider, imageProvider,
      text: { api: textAPI, agy: local.agy, codex: local.codex }, image: { api: imageAPI, agy: local.agy, none: true },
      textReady: Boolean(textProvider && (textProvider === 'api' ? textAPI : local[textProvider])),
      imageReady: imageProvider !== 'none' && Boolean(imageProvider === 'api' ? imageAPI : local.agy),
      connectionNote: '已检查配置和命令位置；登录状态与模型权限需通过连接验证确认。' };
  };
  const resolve = async (provider, kind = 'text') => {
    const report = await describe();
    const selected = !provider || provider === 'auto' ? report[kind === 'image' ? 'imageProvider' : 'textProvider'] : provider;
    if (kind === 'image' && selected === 'none') return 'none';
    if (!selected || report[kind]?.[selected] !== true) throw Object.assign(new Error(kind === 'image' ? '图片接入尚未就绪，请在模型接入中配置；原图已保留。' : '正文接入尚未就绪，请先打开模型接入，配置 API 或安装并登录本地 Agent。'), { code: 'MODEL_NOT_CONFIGURED' });
    return selected;
  };
  const run = async (provider, prompt, cwd, options = {}) => {
    const kind = options.image ? 'image' : 'text';
    provider = await resolve(provider, kind);
    if (provider === 'none') throw Object.assign(new Error('图片重绘已关闭，保留原图。'), { code: 'MODEL_NOT_CONFIGURED' });
    if (provider !== 'api') return agent(provider, prompt, cwd, options);
    const value = settings.current();
    if (kind === 'image' && (typeof options.imageData !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+=*$/i.test(options.imageData))) throw Object.assign(new Error('图片接口缺少有效的图片内容，已保留原图。'), { code: 'MODEL_INPUT' });
    return callCompletion({ baseURL: kind === 'image' ? value.imageApiBaseURL || value.apiBaseURL : value.apiBaseURL,
      model: kind === 'image' ? value.imageModel || value.textModel : value.textModel, key: settings.key(kind), prompt,
      imageData: options.imageData, timeout: options.timeout, onStarted: options.onStarted, fetcher });
  };
  const probe = async kind => {
    if (!['text', 'image'].includes(kind)) throw new Error('连接验证类型无效。');
    const provider = await resolve(null, kind);
    if (provider === 'none') return { ok: true, message: '图片重绘已关闭，文章会保留原图。' };
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quiet-reader-probe-'));
    const started = performance.now();
    try {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
      let prompt = 'This is a connection test. Return only OK. Do not use tools.';
      if (kind === 'image' && provider === 'agy') {
        await mkdir(path.join(directory, '.agents', 'agents'), { recursive: true });
        await writeFile(path.join(directory, '.agents', 'agents', 'quiet-reader-image.md'), await readFile(new URL('./image-agent.md', import.meta.url)));
        await writeFile(path.join(directory, 'probe.png'), png);
        prompt = `用 read_file 查看唯一输入图片 ${JSON.stringify(path.join(directory, 'probe.png'))}，如果能读到图片，只返回 OK。不要读取其他文件。`;
      } else if (kind === 'image') prompt = 'Inspect the attached test image. Return only OK if you can read it.';
      const result = await run(provider, prompt, directory, { image: kind === 'image', imageData: kind === 'image' ? `data:image/png;base64,${png.toString('base64')}` : undefined, timeout: 30_000 });
      if (!/\bOK\b/.test(result)) throw new Error('服务已响应，但未通过测试指令，请检查模型与接入兼容性。');
      return { ok: true, provider, elapsedMs: Math.round(performance.now() - started), message: kind === 'image' ? '图片连接已验证。' : '正文连接已验证。' };
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
  return { describe, resolve, run, probe, refresh: () => commands(true) };
}
