import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const defaults = { textProvider: 'api', imageProvider: 'api', apiBaseURL: '', imageApiBaseURL: '', textModel: '', imageModel: '' };
const variables = { textProvider: 'READER_TEXT_PROVIDER', imageProvider: 'READER_IMAGE_PROVIDER', apiBaseURL: 'READER_API_BASE_URL', imageApiBaseURL: 'READER_IMAGE_API_BASE_URL', textModel: 'READER_TEXT_MODEL', imageModel: 'READER_IMAGE_MODEL' };

export function loadEnvironment(filename) {
  const existing = { ...process.env };
  try { process.loadEnvFile(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 .env 配置，请检查文件格式和权限。'); }
  finally { Object.assign(process.env, existing); }
}

export function validateBaseURL(value) {
  if (typeof value !== 'string' || value.length > 1000) throw new Error('模型服务地址无效。');
  value = value.trim().replace(/\/+$/, '');
  if (!value) return '';
  let url; try { url = new URL(value); } catch { throw new Error('请填写包含 http:// 或 https:// 的模型服务地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error('服务地址需使用 HTTPS；本机服务可用 HTTP。请勿在地址中填写密钥、查询参数或密码。');
  return value;
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new Error('接入配置包含未知字段；密钥请使用页面或环境变量。');
  const result = { ...defaults, ...input };
  // Legacy settings used `auto`; map them to an explicit selection instead of guessing a local agent.
  if (result.textProvider === 'auto') result.textProvider = 'api';
  if (result.imageProvider === 'auto') result.imageProvider = 'api';
  if (!['api', 'agy', 'codex'].includes(result.textProvider) || !['api', 'agy', 'none'].includes(result.imageProvider)) throw new Error('接入方式无效。');
  for (const key of ['apiBaseURL', 'imageApiBaseURL']) result[key] = validateBaseURL(result[key]);
  for (const key of ['textModel', 'imageModel']) {
    if (typeof result[key] !== 'string' || result[key].length > 200 || /[\x00-\x1f]/.test(result[key])) throw new Error('模型名称无效。');
    result[key] = result[key].trim();
  }
  return result;
}

export class ModelSettings {
  constructor(directory, env = process.env) {
    this.file = path.join(directory, 'settings.json'); this.secretsFile = path.join(directory, 'secrets.json');
    this.env = env; this.value = { ...defaults }; this.secrets = {}; this.pending = Promise.resolve();
  }
  async init() {
    try { this.value = validateSettings(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('模型配置无法读取。请检查 data/settings.json，原文件未被覆盖。'); }
    try {
      const value = JSON.parse(await readFile(this.secretsFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      for (const key of ['apiKey', 'imageApiKey']) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 4096)) throw new Error();
      if (value.apiKey) this.secrets.apiKey = value.apiKey;
      if (value.imageApiKey) this.secrets.imageApiKey = value.imageApiKey;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('密钥文件无法读取。请检查 data/secrets.json，原文件未被覆盖。'); }
    this.current(); return this;
  }
  current() {
    const value = { ...this.value };
    for (const [field, variable] of Object.entries(variables)) if (this.env[variable]?.trim()) value[field] = this.env[variable];
    return validateSettings(value);
  }
  public() {
    return { ...this.current(), apiKeyConfigured: Boolean(this.key('text')), imageApiKeyConfigured: Boolean(this.key('image')),
      apiKeyManagedByEnvironment: Boolean(this.env.READER_API_KEY?.trim()), imageApiKeyManagedByEnvironment: Boolean(this.env.READER_IMAGE_API_KEY?.trim()),
      managedByEnvironment: Object.entries(variables).filter(([, variable]) => this.env[variable]?.trim()).map(([field]) => field) };
  }
  key(kind) {
    if (kind !== 'image') return this.env.READER_API_KEY?.trim() || this.secrets.apiKey || '';
    const value = this.current();
    if (this.env.READER_IMAGE_API_KEY?.trim()) return this.env.READER_IMAGE_API_KEY.trim();
    return !value.imageApiBaseURL || value.imageApiBaseURL === value.apiBaseURL
      ? this.env.READER_API_KEY?.trim() || this.secrets.imageApiKey || this.secrets.apiKey || ''
      : this.secrets.imageApiKey || '';
  }
  async saveKeys(input) {
    const next = { ...this.secrets };
    for (const [field, label] of [['apiKey', '正文'], ['imageApiKey', '图片']]) {
      if (!Object.hasOwn(input, field)) continue;
      const value = input[field];
      if (typeof value !== 'string' || value.length > 4096 || /[\r\n\x00]/.test(value)) throw new Error(`${label}密钥格式无效。`);
      if (value.trim()) next[field] = value.trim(); else delete next[field];
    }
    const task = this.pending.then(async () => {
      await mkdir(path.dirname(this.secretsFile), { recursive: true, mode: 0o700 });
      await writeFile(this.secretsFile + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(this.secretsFile + '.tmp', this.secretsFile); this.secrets = next;
    });
    this.pending = task.catch(() => {}); await task; return this.public();
  }
  async save(input) {
    const value = validateSettings(input);
    const task = this.pending.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(this.file + '.tmp', this.file); this.value = value;
    });
    this.pending = task.catch(() => {}); await task; return this.public();
  }
}
