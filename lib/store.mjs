import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import { getArticleTitle } from './article.mjs';
import { imageInsightsMarkdown } from './image-insights.mjs';

export function extractTranslatedTitle(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return '';
  const heading = marked.lexer(markdown).find(token => token.type === 'heading' && token.depth === 1);
  if (!heading) return '';
  const fragment = JSDOM.fragment(marked.parseInline(heading.text));
  fragment.querySelectorAll('script, style').forEach(element => element.remove());
  return fragment.textContent.replace(/\s+/g, ' ').trim().slice(0, 250);
}

function replaceMainHeading(markdown, title) {
  if (typeof markdown !== 'string' || !markdown.trim()) return markdown;
  const heading = marked.lexer(markdown).find(token => token.type === 'heading' && token.depth === 1);
  return heading?.raw ? markdown.replace(heading.raw, `# ${title}\n\n`) : markdown;
}

function isGenericXTranslation(title, originalTitle) {
  if (/(?:\bon X\b|在 X 上)$/i.test(title)) return true;
  const handle = originalTitle.match(/@[\w.]+/)?.[0];
  return Boolean(handle && title.includes(handle));
}

function unreadState() {
  return { status: 'unread', progress: 0, positions: {}, lastMode: 'translated', lastReadAt: null, finishedAt: null, updatedAt: null };
}

function validateReading(input, previous) {
  const modes = ['translated', 'original', 'parallel'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !['unread', 'reading', 'finished'].includes(input.status)
    || !modes.includes(input.lastMode) || !input.positions || typeof input.positions !== 'object' || Array.isArray(input.positions)) {
    throw new Error('阅读状态无效。');
  }
  const positions = {};
  for (const [mode, position] of Object.entries(input.positions)) {
    if (!modes.includes(mode) || !position || !Number.isFinite(position.scrollY) || position.scrollY < 0 || position.scrollY > 10_000_000
      || !Number.isFinite(position.progress) || position.progress < 0 || position.progress > 100
      || typeof position.heading !== 'string' || position.heading.length > 250) throw new Error('阅读位置无效。');
    positions[mode] = { scrollY: position.scrollY, progress: Math.round(position.progress), heading: position.heading };
  }
  const now = new Date().toISOString();
  if (input.status === 'unread') return { ...unreadState(), updatedAt: now };
  return { status: input.status, positions, lastMode: input.lastMode,
    progress: input.status === 'finished' ? 100 : Math.min(99, positions[input.lastMode]?.progress || 0),
    lastReadAt: now, finishedAt: input.status === 'finished' ? previous?.finishedAt || now : null, updatedAt: now };
}

export class ArticleStore {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'articles.json'); this.articles = []; this.pending = Promise.resolve(); }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.articles = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(this.articles) || this.articles.some(a => !/^[a-f0-9-]{36}$/.test(a.id) || typeof a.title !== 'string' || typeof a.original !== 'string')) throw new Error('Invalid article store');
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('文章库无法读取。为保护已有内容，程序没有覆盖它。请检查 data/articles.json。'); }
    for (const article of this.articles) {
      article.reading ||= unreadState();
      const previousTitle = article.title;
      const previousTranslatedTitle = extractTranslatedTitle(article.translated);
      const title = getArticleTitle(article);
      if (title && title !== previousTitle) {
        article.title = title;
      }
      if (article.translated && title && isGenericXTranslation(previousTranslatedTitle, previousTitle) && previousTranslatedTitle !== title) {
        article.translated = replaceMainHeading(article.translated, title);
      }
      article.translatedTitle = extractTranslatedTitle(article.translated);
      if (article.status === 'translating') {
        const done = article.translationDraft?.parts?.filter(Boolean).length || 0;
        article.status = 'error'; article.error = `上次翻译被中断，原文已保存。${done ? `已完成 ${done} / ${article.translationDraft.total} 段，重试会从中断处继续。` : '可以重试。'}`;
      }
      if (['queued', 'running'].includes(article.imageTranslation?.status)) {
        article.imageTranslation.status = 'error';
        article.imageTranslation.error = '上次图片解读被中断，原图和正文译文已保留，可以单独重试。';
        for (const item of article.imageTranslation.items || []) {
          if (['queued', 'running'].includes(item.status)) item.status = 'error';
        }
      }
    }
    await this.save();
  }
  list() { return this.articles.filter(article => !article.deletedAt); }
  get(id) { return this.list().find(a => a.id === id); }
  async add(value) {
    const article = { ...value, id: randomUUID(), createdAt: new Date().toISOString(), starred: false, status: 'original', translated: '', translatedTitle: '', reading: unreadState() };
    this.articles.unshift(article); await this.save(article); return article;
  }
  async update(id, patch) {
    const article = this.get(id); if (!article) throw new Error('文章不存在。');
    Object.assign(article, patch);
    if (Object.hasOwn(patch, 'translated')) article.translatedTitle = extractTranslatedTitle(article.translated);
    await this.save(article); return article;
  }
  async updateReading(id, input) {
    const article = this.get(id);
    if (!article) throw new Error('文章不存在。');
    const reading = validateReading(input, article.reading);
    const previous = article.reading;
    article.reading = reading;
    try { await this.save(article, { markdown: false }); }
    catch (error) { if (article.reading === reading) article.reading = previous; throw error; }
    return article;
  }
  async remove(id) {
    const article = this.get(id);
    if (!article) throw new Error('文章不存在。');
    if (article.status === 'translating') throw new Error('文章正在翻译，请完成后再删除。');
    return this.update(id, { deletedAt: new Date().toISOString() });
  }
  async restore(id) {
    const article = this.articles.find(a => a.id === id && a.deletedAt);
    if (!article) throw new Error('没有找到可恢复的文章。');
    const deletedAt = article.deletedAt;
    delete article.deletedAt;
    try { await this.save(article); }
    catch (error) { article.deletedAt = deletedAt; throw error; }
    return article;
  }
  save(changedArticle, { markdown = true } = {}) {
    const snapshot = JSON.stringify(this.articles, null, 2);
    const files = markdown ? JSON.parse(JSON.stringify(changedArticle ? [changedArticle] : this.articles)) : [];
    const task = this.pending.then(async () => {
      for (const article of files) {
        const directory = path.join(this.directory, 'articles', article.id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        for (const [filename, content] of [['original.md', article.original], ['translated.md', article.translated]]) {
          if (!content) continue;
          let savedContent = content;
          if (filename === 'translated.md') {
            for (const item of article.imageTranslation?.items || []) {
              if (item.status === 'done' && item.url) savedContent = savedContent.replaceAll(item.url, `images/${item.id}/${path.basename(item.url)}`);
            }
            savedContent += imageInsightsMarkdown(article.imageTranslation?.items);
          }
          const heading = /^\s*#\s/m.test(content) ? '' : `# ${article.title.replace(/[\r\n]/g, ' ')}\n\n`;
          const source = article.sourceURL ? `\n\n---\n\n原文：${article.sourceURL}\n` : '\n';
          const target = path.join(directory, filename);
          await writeFile(target + '.tmp', heading + savedContent + source, { mode: 0o600 });
          await rename(target + '.tmp', target);
        }
      }
      const temp = this.file + '.tmp';
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.file);
    });
    this.pending = task.catch(() => {}); return task;
  }
}
