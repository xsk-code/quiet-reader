import { validateURL } from './article.mjs';

export function parseImportInput(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请粘贴文章链接或正文。');
  const content = value.trim();
  const markdownLink = /^\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\)$/.exec(content);
  const candidate = markdownLink ? markdownLink[1] : content;
  if (!/\s/.test(candidate) && /^https?:\/\//i.test(candidate)) return { url: validateURL(candidate).href };
  if (!/\s/.test(candidate) && /^(?:www\.)?[a-z0-9](?:[a-z0-9.-]*\.)[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i.test(candidate)) {
    return { url: validateURL('https://' + candidate).href };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(content) && !/\s/.test(content)) throw new Error('请使用 HTTP / HTTPS 文章链接。');
  if (content.length < 30) throw new Error('请粘贴文章链接，或至少 30 个字符的正文。');
  if (content.length > 120_000) throw new Error('正文超过 12 万字符，请分段导入。');
  const firstLine = content.split('\n').find(line => line.trim()) || '';
  const title = firstLine.replace(/^#{1,6}\s+/, '').trim();
  return { markdown: content, title: /^(`{3,}|~{3,})/.test(title) ? '导入的文章' : title.slice(0, 100) };
}
