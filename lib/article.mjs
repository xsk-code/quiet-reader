import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import gfm from 'turndown-plugin-gfm';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8], ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',3]]) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
specialV6.addSubnet('2001::', 23, 'ipv6');
specialV6.addSubnet('2001:db8::', 32, 'ipv6');
specialV6.addSubnet('2002::', 16, 'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}

export function validateURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的网址，例如 https://example.com/article'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('只支持不含账号密码、使用标准端口的 HTTP / HTTPS 文章网址。');
  return url;
}

const PASTE_HINT = '请在浏览器里打开原文，全选复制后点「粘贴」导入。';

// Name the likely cause per status so the user knows whether retrying can help.
export function pageStatusError(status) {
  const message = status === 401 || status === 403 ? `网站拒绝了程序访问（HTTP ${status}），常见于需要登录、付费墙或人机验证的网站。${PASTE_HINT}`
    : status === 404 || status === 410 ? `页面不存在（HTTP ${status}），请检查链接是否完整。`
    : status === 429 ? `网站限制了访问频率（HTTP 429），请稍后再试，或${PASTE_HINT.slice(1)}`
    : status >= 500 ? `网站暂时出错（HTTP ${status}），请稍后重试；急用时${PASTE_HINT.slice(1)}`
    : `网站返回 HTTP ${status}，无法直接提取正文。${PASTE_HINT}`;
  return Object.assign(new Error(message), { code: 'FETCH_HTTP', status });
}

function requestHTML(url, pinned, timeout) {
  return new Promise((resolve, reject) => {
    // Pin each attempt to an address already checked by the public-address guard.
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      headers: { 'User-Agent': 'QuietReader/0.1 (personal article reader)', Accept: 'text/html,application/xhtml+xml' },
      lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); resolve({ redirect: new URL(res.headers.location, url).href }); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(pageStatusError(res.statusCode)); return; }
      if (!/text\/html|application\/xhtml\+xml/i.test(res.headers['content-type'] || '')) { res.resume(); reject(new Error('该链接不是 HTML 文章。请提供文章网页，或直接导入 Markdown。')); return; }
      const buffers = []; let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > 3_000_000) { request.destroy(Object.assign(new Error('网页超过 3 MB，请直接粘贴文章正文。'), { code: 'EREADERLIMIT' })); return; }
        buffers.push(chunk);
      });
      res.on('end', () => {
        const buffer = Buffer.concat(buffers);
        const charset = /charset=["']?([\w-]+)/i.exec(res.headers['content-type'])?.[1] || /charset=["']?([\w-]+)/i.exec(buffer.subarray(0, 2048).toString())?.[1] || 'utf-8';
        try { resolve({ html: new TextDecoder(charset).decode(buffer), url: url.href }); }
        catch { resolve({ html: buffer.toString('utf8'), url: url.href }); }
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('网页连接超时。'), { code: 'ETIMEDOUT' })), timeout);
    request.on('close', () => clearTimeout(timer));
    request.on('error', error => {
      if (error.code === 'EREADERLIMIT') { reject(error); return; }
      const retryable = ['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(error.code);
      reject(Object.assign(new Error(retryable ? '网页连接失败，请稍后重试。' : '网页连接失败，请检查网址或网站的证书。'), { retryable }));
    });
  });
}

// X keeps long-form posts and Articles behind a login. Without a signed-in
// browser it answers with an onboarding page whose boilerplate is long enough to
// pass Readability, so refuse it instead of saving a login screen as an article.
export const X_LOGIN_MESSAGE = '这是 X 上需要登录才能看的内容，程序不会使用你的账号去抓取。请在浏览器里打开原文，全选复制后点「粘贴」导入。';

export function xLoginRequired() {
  return Object.assign(new Error(X_LOGIN_MESSAGE), { code: 'X_LOGIN_REQUIRED' });
}

function isXHost(value) {
  try { return /^(?:www\.)?(?:x\.com|twitter\.com)$/i.test(new URL(value).hostname); }
  catch { return false; }
}

function isXLoginURL(value) {
  try { return isXHost(value) && /^\/(?:i\/jf\/onboarding|i\/flow\/login|login)(?:\/|$)/i.test(new URL(value).pathname); }
  catch { return false; }
}

function isXLoginShell(document) {
  // Rendered posts expose tweet text or the native Article view; the logged-out
  // shell only ships sidebar cards, which also use <article> wrappers.
  if (document.querySelector('[data-testid="tweetText"], [data-testid="twitterArticleRichTextView"]')) return false;
  return Boolean(document.querySelector('a[href*="/i/jf/onboarding"], a[href*="/i/flow/login"]'))
    || /log in or sign up|登录或注册/i.test(document.body?.textContent || '');
}

export async function fetchArticleHTML(value, redirects = 0, { resolveAddresses = lookup, requestPage = requestHTML } = {}) {
  if (redirects > 5) throw new Error(`网页跳转次数过多。${PASTE_HINT}`);
  const url = validateURL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let dnsTimer;
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
      resolveAddresses(host, { all: true }),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('DNS timeout')), 7000); }),
    ]);
  } catch { throw new Error('无法解析文章网站的地址，请检查网络后重试。'); }
  finally { clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('请使用公开的文章网址，不支持本机或内网地址。');
  // Some local networks resolve IPv6 addresses even though IPv6 HTTPS is unreachable.
  const ordered = [...addresses].sort((a, b) => a.family - b.family);
  const deadline = Date.now() + 25_000;
  let response;
  for (const address of ordered) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try { response = await requestPage(url, address, Math.min(10_000, remaining)); break; }
    catch (error) { if (!error.retryable) throw error; }
  }
  if (!response) throw new Error('网页获取超时或无法连接，已尝试备用网络地址。请检查网络后重试。');
  if (response.redirect) {
    if (isXLoginURL(response.redirect)) throw xLoginRequired();
    return fetchArticleHTML(response.redirect, redirects + 1, { resolveAddresses, requestPage });
  }
  const linkedArticle = xLinkedArticleURL(response.html, url.href);
  if (linkedArticle) {
    try { return await fetchArticleHTML(linkedArticle, redirects + 1, { resolveAddresses, requestPage }); }
    catch (error) { throw new Error(`已识别 X 帖子的外链文章，但全文获取失败：${error.message}`); }
  }
  return response;
}

function xLinkedArticleURL(html, value) {
  if (!isXArticleURL(value)) return null;
  const source = new URL(value);
  const statusId = /^\/[^/]+\/status\/(\d+)(?:\/|$)/.exec(source.pathname)?.[1];
  if (!statusId) return null;
  const dom = new JSDOM(html, { url: value });
  try {
    const document = dom.window.document;
    if (document.querySelector('[data-testid="twitterArticleRichTextView"]')) return null;
    const description = document.querySelector('meta[property="og:description"]')?.content || '';
    const mainPosts = [...document.querySelectorAll('article')].filter(post => [...post.querySelectorAll('a[href]')].some(link => {
      try {
        const target = new URL(link.getAttribute('href'), value);
        return link.closest('article') === post && isXArticleURL(target.href)
          && /^\/[^/]+\/status\/(\d+)(?:\/|$)/.exec(target.pathname)?.[1] === statusId;
      } catch { return false; }
    }));
    const destinations = new Set();
    for (const link of document.querySelectorAll('a[href]')) {
      let target;
      try { target = validateURL(new URL(link.getAttribute('href'), value).href); }
      catch { continue; }
      if (/^(?:www\.)?(?:x\.com|twitter\.com)$/i.test(target.hostname)) continue;
      if (!mainPosts.includes(link.closest('article')) && !description.includes(target.href)) continue;
      const cardImage = [...link.querySelectorAll('img[src]')].some(image => {
        try {
          const imageURL = new URL(image.getAttribute('src'), value);
          return imageURL.hostname === 'pbs.twimg.com' && imageURL.pathname.startsWith('/card_img/');
        } catch { return false; }
      });
      if (link.textContent.trim() && (cardImage || link.closest('[data-testid="card.wrapper"]'))) destinations.add(target.href);
    }
    if (destinations.size !== 1) return null;
    const destination = [...destinations][0];
    return new URL(destination).hostname === 't.co' ? expandedXLink(document, destination) : destination;
  } finally { dom.window.close(); }
}

function expandedXLink(document, destination) {
  // X embeds URL entities as JSON inside hydration strings; never execute page scripts.
  for (const script of document.querySelectorAll('script')) {
    const pending = [];
    try { pending.push(JSON.parse(script.textContent)); }
    catch {
      for (const match of script.textContent.matchAll(/"(?:\\.|[^"\\])*"/g)) {
        try {
          const value = JSON.parse(match[0]);
          if (/^\s*[\[{]/.test(value)) pending.push(JSON.parse(value));
        } catch {}
      }
    }
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === 'string') {
        if (/^\s*[\[{]/.test(value)) { try { pending.push(JSON.parse(value)); } catch {} }
      } else if (value && typeof value === 'object') {
        if (value.url === destination && typeof value.expanded_url === 'string') {
          try { return validateURL(value.expanded_url).href; } catch {}
        }
        for (const child of Object.values(value)) pending.push(child);
      }
    }
  }
  return destination;
}

export function isXArticleURL(value) {
  try {
    const url = new URL(value);
    return /^(?:www\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)
      && /^\/[^/]+\/(?:status|article)\/\d+(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

export function getArticleTitle({ title, excerpt, sourceURL }) {
  const originalTitle = typeof title === 'string' ? title.trim() : '';
  const candidate = typeof excerpt === 'string' ? excerpt.trim() : '';
  const genericXTitle = /(?:\bon X\b|在 X 上)$/i.test(originalTitle);
  return isXArticleURL(sourceURL) && genericXTitle && candidate && candidate.length <= 250
    ? candidate : originalTitle;
}

function markdownFromHTML(html, url) {
  const content = new JSDOM(html, { url });
  try {
    // Readability can wrap only the opening bracket before a legacy numeric anchor.
    for (const paragraph of content.window.document.querySelectorAll('p')) {
      const anchor = paragraph.nextSibling;
      if (!paragraph.children.length && paragraph.textContent.trim() === '['
        && anchor?.nodeType === 1 && anchor.matches('a[name]:not([href]), a[id]:not([href])')
        && /^\d+$/.test(anchor.textContent.trim()) && /^\s*\]/.test(anchor.nextSibling?.textContent || '')) {
        paragraph.replaceWith(...paragraph.childNodes);
      }
    }
    for (const el of content.window.document.querySelectorAll('[href], [src]')) {
      for (const attr of ['href', 'src']) {
        if (!el.hasAttribute(attr)) continue;
        try {
          const absolute = new URL(el.getAttribute(attr), url);
          if (['https:', 'http:'].includes(absolute.protocol)) el.setAttribute(attr, absolute.href);
          else el.removeAttribute(attr);
        } catch { el.removeAttribute(attr); }
      }
    }
    const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    converter.use(gfm.gfm);
    converter.keep(['sup']);
    converter.addRule('linkedImage', {
      filter: node => node.nodeName === 'A' && node.querySelectorAll('img').length === 1 && !node.textContent.trim(),
      replacement: (content, node) => {
        const image = content.trim();
        // Block wrappers inside an anchor must not split the Markdown link across paragraphs.
        return /^!\[[^\n]*\]\([^\n]+\)$/.test(image) && node.getAttribute('href')
          ? `\n\n[${image}](${node.getAttribute('href')})\n\n`
          : node.getAttribute('href') ? `[${content}](${node.getAttribute('href')})` : content;
      },
    });
    converter.remove(['script', 'style', 'iframe', 'form', 'button', 'input']);
    const markdown = converter.turndown(content.window.document.body.innerHTML).trim();
    if (markdown.length > 120_000) throw new Error('文章超过 12 万字符，请分段粘贴导入，以保证翻译完整。');
    return markdown;
  } finally { content.window.close(); }
}

export function extractArticle(html, url) {
  const dom = new JSDOM(html, { url });
  try {
    if (isXHost(url) && isXLoginShell(dom.window.document)) throw xLoginRequired();
    const source = new URL(url); source.hash = '';
    // Legacy font wrappers split inline citations from their paragraph in Readability.
    for (const font of dom.window.document.querySelectorAll('font')) {
      if (font.closest('pre, code')) continue;
      const link = font.querySelector('a[href]');
      const number = link?.textContent.trim();
      if (!/^\d+$/.test(number || '') || font.textContent.trim() !== `[${number}]` || font.querySelectorAll('a').length !== 1) continue;
      let target;
      try { target = new URL(link.getAttribute('href'), url); }
      catch { continue; }
      if (target.hash !== `#f${number}n`) continue;
      target.hash = '';
      if (target.href !== source.href) continue;
      const reference = dom.window.document.createElement('sup');
      link.replaceChildren(number); reference.append('[', link, ']'); font.replaceWith(reference);
    }
    // A signed-in X render exposes the Article body directly; Readability would
    // otherwise keep the surrounding timeline chrome.
    const articleView = dom.window.document.querySelector('[data-testid="twitterArticleRichTextView"]');
    if (articleView && isXHost(url)) {
      const markdown = markdownFromHTML(articleView.innerHTML, url);
      if (markdown.length >= 100) {
        const document = dom.window.document;
        const excerpt = document.querySelector('meta[property="og:description"]')?.content || '';
        const heading = (document.querySelector('meta[property="og:title"]')?.content || document.title || '').replace(/\s*\/\s*X\s*$/i, '');
        const title = getArticleTitle({ title: heading, excerpt, sourceURL: url });
        return { title: title || new URL(url).hostname, author: '', excerpt, original: markdown, sourceURL: url, siteName: 'X (formerly Twitter)' };
      }
    }
    const result = new Readability(dom.window.document).parse();
    if (!result || (result.textContent || '').trim().length < 100) throw Object.assign(new Error(`没有提取到足够的正文，网页可能需要登录或依赖脚本动态加载。${PASTE_HINT}`), { code: 'FETCH_EMPTY' });
    const markdown = markdownFromHTML(result.content, url);
    const title = getArticleTitle({ title: result.title, excerpt: result.excerpt, sourceURL: url });
    return { title: title || new URL(url).hostname, author: result.byline || '', excerpt: result.excerpt || '', original: markdown, sourceURL: url, siteName: result.siteName || new URL(url).hostname };
  } finally { dom.window.close(); }
}

export function splitMarkdown(text, limit = 9000) {
  const chunks = []; let current = ''; let fence = null; let block = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  const add = value => {
    if (current && current.length + value.length + 2 > limit) flush();
    current += (current ? '\n\n' : '') + value;
  };
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    if (!line.trim() && !fence) { if (block) add(block); block = ''; }
    else block += (block ? '\n' : '') + line;
  }
  if (block) add(block);
  flush();
  if (chunks.some(chunk => chunk.length > 32_000)) throw new Error('文章中有超过 3.2 万字符的连续段落或代码块，请分段后导入。');
  return chunks;
}
