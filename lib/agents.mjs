import { spawn } from 'node:child_process';

export function cleanAgentOutput(text) {
  const trimmed = text.trim();
  const wrapped = /^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  return wrapped ? wrapped[1].trim() : trimmed;
}

export function imageRateLimitError(output) {
  try {
    const result = JSON.parse(cleanAgentOutput(output).replace(/^```json\s*\n([\s\S]*?)\n```$/, '$1'));
    if (['done', 'skipped'].includes(result?.status)) return null;
  } catch {}
  if (!/\b429\b|RESOURCE_EXHAUSTED|quota|配额|额度|too many requests|rate.?limit/i.test(output)) return null;
  return Object.assign(new Error('图片模型额度或调用频率受限（429），已保留原图。请等额度恢复后点击“重试图片重绘”。'), { code: 'IMAGE_RATE_LIMIT' });
}

export function runAgent(provider, prompt, cwd, { timeout = 240_000, onStarted = () => {}, image = false } = {}) {
  if (!['agy', 'codex'].includes(provider)) return Promise.reject(new Error('请选择 Codex 或 agy。'));
  const executable = provider === 'agy' ? process.env.AGY_BIN || 'agy' : process.env.CODEX_BIN || 'codex';
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) return Promise.reject(new Error('Windows 暂不支持通过 .cmd/.bat 启动本地 Agent，请使用 API 接入或指向可执行文件。'));
  const args = provider === 'agy'
    ? ['--model', image ? 'gemini-3.8-flash-high' : 'gemini-3.8-flash-low', ...(image ? ['--agent', 'quiet-reader-image'] : []), '--print', prompt, '--sandbox', '--disable-slash-commands', '--output-format', 'text', '--print-timeout', image ? '540s' : '210s']
    : ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-'];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const stop = () => { try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const timer = setTimeout(() => { stop(); finish(image ? new Error('图片解读超时，已保留原图，可以单独重试。') : Object.assign(new Error('Agent 翻译超时，原文已经保存。可以稍后重试或换一个 Agent。'), { code: 'MODEL_TIMEOUT' })); }, timeout);
    child.once('spawn', () => onStarted({ provider, pid: child.pid }));
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 1_000_000) { stop(); finish(new Error('Agent 返回内容过大，请分段导入。')); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', () => {});
    child.on('error', error => finish(new Error(error.code === 'ENOENT' ? `没有找到 ${provider} 命令。请安装并登录，或设置对应的 BIN 环境变量。` : '无法启动 Agent，请检查本机安装状态。')));
    child.on('close', code => {
      const rateLimit = image && code !== 0 && imageRateLimitError(stderr + stdout);
      if (rateLimit) { finish(rateLimit); return; }
      if (/location is not supported/i.test(stderr + stdout)) { finish(new Error('agy 当前账号或地区无法调用模型。原文已保存，请切换 Codex 后重试。')); return; }
      if (code !== 0) { finish(new Error(`${provider} 翻译失败（退出码 ${code ?? '未知'}）。原文已保存，请先在终端确认该 Agent 已登录且可用。`)); return; }
      const result = cleanAgentOutput(stdout);
      finish(result ? null : new Error('Agent 没有返回译文，原文已保存，请重试。'), result);
    });
    child.stdin.end(provider === 'codex' ? prompt : undefined);
  });
}
