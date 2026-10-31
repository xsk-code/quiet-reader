import { xLoginRequired } from './article.mjs';

// X serves long-form bodies only to signed-in browsers, but FxTwitter (the
// open-source FxEmbed project, also self-hostable) republishes them through a
// plain JSON endpoint. That keeps the reader free of account sessions: nothing
// is sent to X, no cookie is reused, and the request can be pointed at your own
// deployment with READER_X_API.

const DEFAULT_BASE = 'https://api.fxtwitter.com';

export function xAPIBase(env = process.env) {
  const configured = String(env.READER_X_API || '').trim().replace(/\/+$/, '');
  if (/^(?:off|none|false|0)$/i.test(configured)) return '';
  return configured || DEFAULT_BASE;
}

export function statusPath(value) {
  try {
    const url = new URL(value);
    if (!/^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)) return '';
    const match = /^\/([^/]+)\/status\/(\d+)(?:\/|$)/i.exec(url.pathname) || /^\/i\/status\/(\d+)(?:\/|$)/i.exec(url.pathname);
    if (!match) return '';
    return match.length === 3 ? `/${match[1]}/status/${match[2]}` : `/i/status/${match[1]}`;
  } catch { return ''; }
}

const ESCAPE = /[\\`[\]]/g;
const escapeText = text => text.replace(ESCAPE, character => `\\${character}`);

function renderInline(block, entityMap) {
  const text = block.text || '';
  const marks = Array.from({ length: text.length }, () => ({}));
  for (const range of block.entityRanges || []) {
    const entity = entityMap?.[range.key]?.value;
    if (entity?.type !== 'LINK' || !entity.data?.url) continue;
    for (let index = range.offset; index < Math.min(range.offset + range.length, text.length); index++) marks[index].link = entity.data.url;
  }
  for (const range of block.inlineStyleRanges || []) {
    for (let index = range.offset; index < Math.min(range.offset + range.length, text.length); index++) marks[index][range.style] = true;
  }
  let out = '';
  let previous = {};
  for (let index = 0; index < text.length; index++) {
    const mark = marks[index];
    if (mark.link !== previous.link || Boolean(mark.Bold) !== Boolean(previous.Bold)
      || Boolean(mark.Italic) !== Boolean(previous.Italic) || Boolean(mark.Strikethrough) !== Boolean(previous.Strikethrough)) {
      if (previous.Strikethrough) out += '~~';
      if (previous.Italic) out += '*';
      if (previous.Bold) out += '**';
      if (previous.link) out += `](${previous.link})`;
      if (mark.link) out += '[';
      if (mark.Bold) out += '**';
      if (mark.Italic) out += '*';
      if (mark.Strikethrough) out += '~~';
    }
    out += escapeText(text[index]);
    previous = mark;
  }
  if (previous.Strikethrough) out += '~~';
  if (previous.Italic) out += '*';
  if (previous.Bold) out += '**';
  if (previous.link) out += `](${previous.link})`;
  return out;
}

function mediaMarkdown(block, entityMap, mediaEntities) {
  const lines = [];
  for (const range of block.entityRanges || []) {
    const entity = entityMap?.[range.key]?.value;
    if (entity?.type !== 'MEDIA') continue;
    for (const item of entity.data?.mediaItems || []) {
      const media = mediaEntities?.find(entry => String(entry.media_id) === String(item.mediaId));
      const info = media?.media_info || {};
      const source = info.original_img_url || info.url || '';
      if (!source) continue;
      const alt = (info.ext_alt_text || '').replace(/[\[\]\n]/g, ' ').trim();
      lines.push(`![${alt || '图片'}](${source})`);
    }
  }
  return lines;
}

/** Convert the Draft.js body FxTwitter returns into Markdown. */
export function articleToMarkdown(article) {
  const content = typeof article?.content === 'string' ? safeParse(article.content) : article?.content;
  const blocks = content?.blocks || [];
  const entityMap = content?.entityMap || {};
  const mediaEntities = article?.media_entities || [];
  const rendered = [];
  for (const block of blocks) {
    const text = renderInline(block, entityMap);
    let markdown = '';
    let list = false;
    switch (block.type) {
      case 'header-one': markdown = `# ${text}`; break;
      case 'header-two': markdown = `## ${text}`; break;
      case 'header-three': markdown = `### ${text}`; break;
      case 'blockquote': {
        const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
        const previous = rendered.at(-1);
        // Adjacent quotes read as one block.
        if (previous?.quote) { previous.text += `\n${quoted}`; continue; }
        rendered.push({ text: quoted, quote: true });
        continue;
      }
      case 'unordered-list-item': markdown = `${'  '.repeat(block.depth || 0)}- ${text}`; list = true; break;
      case 'ordered-list-item': markdown = `${'  '.repeat(block.depth || 0)}1. ${text}`; list = true; break;
      case 'code-block': markdown = ['```', block.text || '', '```'].join('\n'); break;
      case 'atomic': markdown = mediaMarkdown(block, entityMap, mediaEntities).join('\n\n'); break;
      default: markdown = text;
    }
    if (!markdown) continue;
    // Consecutive list items stay in one tight list.
    if (list && rendered.at(-1)?.list) { rendered.at(-1).text += `\n${markdown}`; continue; }
    rendered.push({ text: markdown, list });
  }
  return rendered.map(item => item.text).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function photoMarkdown(tweet) {
  const photos = tweet?.media?.photos || [];
  return photos.map(photo => `![图片](${photo.url})`).join('\n\n');
}

/** Turn an FxTwitter status payload into a reader article, or null when empty. */
export function xArticleFromJSON(payload, sourceURL) {
  const tweet = payload?.tweet;
  if (!tweet) return null;
  const article = tweet.article;
  if (article?.content) {
    const original = articleToMarkdown(article);
    if (original.length < 100) return null;
    return {
      title: (article.title || tweet.text || 'X 长文').slice(0, 250),
      author: [tweet.author?.name, tweet.author?.screen_name && `@${tweet.author.screen_name}`].filter(Boolean).join(' '),
      excerpt: (article.preview_text || '').slice(0, 500),
      original, sourceURL, siteName: 'X (formerly Twitter)',
    };
  }
  const text = tweet.text || tweet.raw_text || '';
  if (text.trim().length < 40) return null;
  const photos = photoMarkdown(tweet);
  return {
    title: text.trim().split('\n')[0].slice(0, 120),
    author: [tweet.author?.name, tweet.author?.screen_name && `@${tweet.author.screen_name}`].filter(Boolean).join(' '),
    excerpt: text.slice(0, 500),
    original: photos ? `${text.trim()}\n\n${photos}` : text.trim(),
    sourceURL, siteName: 'X (formerly Twitter)',
  };
}

export async function fetchXArticle(value, { env = process.env, fetchJSON = defaultFetchJSON } = {}) {
  const base = xAPIBase(env);
  const path = statusPath(value);
  if (!path) throw xLoginRequired();
  if (!base) throw new Error('已关闭 X 公开接口（READER_X_API=off）。请打开原文，复制正文后点「粘贴」导入。');
  const payload = await fetchJSON(`${base}${path}`);
  const article = xArticleFromJSON(payload, value);
  if (!article) throw new Error('这个 X 链接没有可读的公开正文（可能是只有登录才可见的长文，或作者限制了访问）。请打开原文，复制正文后点「粘贴」导入。');
  return article;
}

async function defaultFetchJSON(url) {
  const response = await fetch(url, {
    redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'QuietReader/0.1 (personal article reader)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`X 公开接口返回 ${response.status}，请稍后重试，或复制正文后点「粘贴」导入。`);
  try { return await response.json(); }
  catch { throw new Error('X 公开接口返回了无法解析的内容，请稍后重试。'); }
}
