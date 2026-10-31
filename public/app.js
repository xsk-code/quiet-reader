'use strict';
import * as imageInsights from './image-insights.mjs';
import { languages, languageOf, languageFromLocale, findLanguage, defaultLanguage } from './languages.mjs';
const articleMarkdown = new marked.Marked({
  extensions: [{
    name: 'multilineImageLink',
    level: 'block',
    start(source) { return /^ {0,3}\[[ \t]*\n(?:[ \t]*\n)*[ \t]*!\[/m.exec(source)?.index; },
    tokenizer(source) {
      const match = /^ {0,3}\[[ \t]*\n(?:[ \t]*\n)*[ \t]*(!\[[^\n]*\]\([^\n]+\))[ \t]*\n(?:[ \t]*\n)*[ \t]*\]\((https?:\/\/[^\s]+)\)[ \t]*(?:\n|$)/.exec(source);
      if (!match) return;
      const text = `[${match[1]}](${match[2]})`;
      const tokens = this.lexer.inlineTokens(text);
      if (tokens.length !== 1 || tokens[0].type !== 'link' || tokens[0].tokens?.length !== 1 || tokens[0].tokens[0].type !== 'image') return;
      return { type: 'multilineImageLink', raw: match[0], tokens };
    },
    renderer(token) { return `<p>${this.parser.parseInline(token.tokens)}</p>\n`; },
  }, {
    name: 'chineseUnderscoreEmphasis',
    level: 'inline',
    start(source) { return source.indexOf('_'); },
    tokenizer(source, tokens) {
      if (this.lexer.state.inRawBlock) return;
      // Allow underscores inside Chinese sentences while leaving code and Latin identifiers literal.
      const match = /^(__|_)(?!_)((?:\\[^\n]|`+[^`\n]*`+|!?\[[^\]\n]*\]\((?:\\.|[^()\n]|\([^()\n]*\))*\)|<[^>\n]+>|[^_\\`\n])+?)\1(?!_)/u.exec(source);
      if (!match || match[2].trim() !== match[2] || !/\p{Script=Han}/u.test(match[2])) return;
      if (/[a-z0-9_]$/i.test(tokens.at(-1)?.raw || '') && /^[a-z0-9]/i.test(match[2])) return;
      return { type: 'chineseUnderscoreEmphasis', raw: match[0], tag: match[1].length === 2 ? 'strong' : 'em', tokens: this.lexer.inlineTokens(match[2]) };
    },
    renderer(token) { return `<${token.tag}>${this.parser.parseInline(token.tokens)}</${token.tag}>`; },
  }],
});
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let articles = [];
const emptyArticle = { id: 'empty', title: '', original: '', translated: '' };
let selected = emptyArticle;
const deletingArticles = new Set();
const savingStars = new Set();
let mode = 'translated';
let filter = 'all';
let statusFilter = 'all';
let busy = false;
let activeJob = null;
let outlineObserver;
let toastTimer;
let imagePollTimer = null;
const readingStates = new Map();
const readingSaves = new Map();
const savedReadingStates = new Map();
let scrollTimer;
let restoringPosition = false;
let lastScrollY = 0;
let restoreVersion = 0;
let modelReport = null;
let providerAvailable = false;
const modelFields = { apiBaseURL: '#setup-api-base-url', imageApiBaseURL: '#setup-image-api-base-url', textModel: '#setup-text-model', imageModel: '#setup-image-model' };
function toggleImageFields() { $('#setup-image-fields').hidden = $('#setup-image-mode').value !== 'separate'; }

function openModelSetup() {
  const dialog = $('#model-setup');
  if (!dialog.open) dialog.showModal();
}
function closeModelSetup() { $('#model-setup').close(); saveSetting('setupDismissed', 'yes'); }
function renderModelSetup(report) {
  modelReport = report;
  $('#setup-probe-result').textContent = '';
  $('#setup-models-status').textContent = '';
  for (const [key, selector] of Object.entries(modelFields)) {
    $(selector).value = report.settings[key] || '';
    $(selector).disabled = report.settings.managedByEnvironment.includes(key);
  }
  const imageMode = report.settings.imageProvider === 'none' ? 'none' : report.settings.imageApiBaseURL || report.settings.imageModel ? 'separate' : 'inherit';
  $('#setup-image-mode').value = imageMode;
  $('#setup-image-mode').disabled = report.settings.managedByEnvironment.includes('imageProvider');
  $('#image-settings').open = imageMode === 'separate';
  toggleImageFields();
  $('#setup-env-note').hidden = !(report.settings.managedByEnvironment.length || report.settings.apiKeyManagedByEnvironment || report.settings.imageApiKeyManagedByEnvironment);
  for (const [id, configured, managed] of [['#setup-api-key', report.settings.apiKeyConfigured, report.settings.apiKeyManagedByEnvironment], ['#setup-image-api-key', report.settings.imageApiKeyConfigured, report.settings.imageApiKeyManagedByEnvironment]]) {
    $(id).value = ''; $(id).disabled = managed;
    $(id).placeholder = configured ? '已配置，留空不修改' : '粘贴密钥；仅保存在本机';
  }
  const names = { api: '模型 API', agy: '本地 agy', codex: '本地 Codex', none: '保留原图' };
  $('#connection-summary').textContent = `正文：${report.textReady ? names[report.textProvider] : '尚未配置'} · 图片：${report.imageReady ? names[report.imageProvider] : '保留原图'}`;
  const legacy = !report.settings.managedByEnvironment.includes('textProvider') && report.settings.textProvider !== 'api';
  $('#setup-status').textContent = legacy ? '当前由本地 Agent 提供；保存本页 API 配置后会改用 API。' : report.connectionNote;
  const providerSelect = $('#provider');
  for (const option of providerSelect.options) option.disabled = report.text[option.value] !== true;
  const available = [...providerSelect.options].filter(option => !option.disabled);
  providerAvailable = available.length > 0;
  providerSelect.hidden = available.length <= 1;
  const preferred = readSetting('provider', '');
  providerSelect.value = available.some(option => option.value === preferred) ? preferred : available.some(option => option.value === report.textProvider) ? report.textProvider : available[0]?.value || 'api';
  $('#import-button').disabled = !providerAvailable;
  if (!findLanguage(readSetting('targetLanguage', '')) && findLanguage(report.targetLanguage)) $('#target-language').value = report.targetLanguage;
  $('#probe-text').disabled = !report.textReady;
  $('#probe-image').disabled = !report.imageReady;
  if (selected.translated) renderArticleNotice();
}

$('#setup-image-mode').addEventListener('change', toggleImageFields);
$('#setup-fetch-models').addEventListener('click', async () => {
  const button = $('#setup-fetch-models'); button.disabled = true;
  $('#setup-models-status').textContent = '读取中…';
  try {
    const baseURL = $('#setup-api-base-url').value.trim(), apiKey = $('#setup-api-key').value.trim();
    const result = await api('/api/setup/models', { method: 'POST', body: JSON.stringify({ baseURL, ...(apiKey ? { apiKey } : {}) }) });
    const options = $('#setup-model-options'); options.replaceChildren(...result.models.map(id => { const option = document.createElement('option'); option.value = id; return option; }));
    $('#setup-models-status').textContent = `找到 ${result.models.length} 个模型，点击输入框选择`;
    $('#setup-text-model').focus();
  } catch (error) { $('#setup-models-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#model-setup-toggle').addEventListener('click', openModelSetup);
$('#configure-models').addEventListener('click', openModelSetup);
$('#model-setup-close').addEventListener('click', closeModelSetup);
$('#model-setup-done').addEventListener('click', closeModelSetup);
$('#model-setup').addEventListener('click', event => {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  // 只有点在对话框之外的遮罩上才关闭；点卡片内边距不关闭。
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModelSetup();
});
$('#model-setup').addEventListener('cancel', () => saveSetting('setupDismissed', 'yes'));
$('#model-setup-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter || $('#model-setup-form button[type="submit"]'); button.disabled = true;
  try {
    const mode = $('#setup-image-mode').value;
    const value = { textProvider: 'api', imageProvider: mode === 'none' ? 'none' : 'api',
      apiBaseURL: $('#setup-api-base-url').value, textModel: $('#setup-text-model').value,
      imageApiBaseURL: mode === 'separate' ? $('#setup-image-api-base-url').value : '',
      imageModel: mode === 'separate' ? $('#setup-image-model').value : '' };
    const apiKey = $('#setup-api-key').value.trim(), imageApiKey = $('#setup-image-api-key').value.trim();
    if (apiKey) value.apiKey = apiKey; if (imageApiKey) value.imageApiKey = imageApiKey;
    const saved = await api('/api/setup', { method: 'PUT', body: JSON.stringify(value) });
    $('#setup-api-key').value = ''; $('#setup-image-api-key').value = '';
    renderModelSetup(saved);
    $('#setup-status').textContent = saved.textReady ? '配置已保存。可验证连接，或关闭此窗口开始阅读。' : '配置已保存，但正文接入尚未就绪；请检查地址、模型或本地命令。';
    $('#model-setup-done').textContent = saved.textReady ? '完成，开始阅读' : '稍后配置';
  } catch (error) { $('#setup-status').textContent = error.message; }
  finally { button.disabled = false; }
});
for (const kind of ['text', 'image']) $(`#probe-${kind}`).addEventListener('click', async () => {
  const button = $(`#probe-${kind}`); button.disabled = true;
  $('#setup-probe-result').textContent = '正在验证连接，最多等待 30 秒…';
  try { const result = await api('/api/setup/probe', { method: 'POST', body: JSON.stringify({ kind }) }); $('#setup-probe-result').textContent = result.message; }
  catch (error) { $('#setup-probe-result').textContent = error.message; }
  finally { button.disabled = false; }
});

function readSetting(key, fallback) { try { return localStorage.getItem(`shiye.${key}`) || fallback; } catch { return fallback; } }
function saveSetting(key, value) { try { localStorage.setItem(`shiye.${key}`, value); } catch {} }
// The browser extension opens /?job=<uuid> after it queues an import, or
// /?pending=<url> when it could not reach the service and needs one confirmation.
function launchRequest() {
  const params = new URLSearchParams(location.search);
  const job = params.get('job') || '';
  const pending = params.get('pending') || '';
  return {
    job: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job) ? job : '',
    pending: /^https?:\/\/[^\s]+$/i.test(pending) && pending.length <= 4096 ? pending : '',
  };
}
function clearLaunchRequest() { if (location.search) history.replaceState(null, '', location.pathname + location.hash); }
function displayTitle(article) { return article.translatedTitle || article.title; }
function readingState(article) {
  return readingStates.get(article.id) || article.reading || { status: 'unread', progress: 0, positions: {}, lastMode: 'translated', lastReadAt: null, finishedAt: null };
}
function readingLabel(article) {
  const reading = readingState(article);
  return reading.status === 'finished' ? '已读完' : reading.status === 'reading' ? `阅读中 · ${reading.progress}%` : '未读';
}
function rememberReading(article, reading) {
  readingStates.set(article.id, reading); article.reading = reading;
  saveSetting(`reading.${article.id}`, JSON.stringify(reading));
}
function renderReadingState() {
  const empty = selected.id === 'empty';
  $('#reading-control').hidden = empty;
  if (empty) return;
  const reading = readingState(selected);
  $('#reading-status').value = reading.status;
  $('#reading-progress').textContent = reading.status === 'reading' ? `${reading.progress}%` : '';
  const heading = reading.positions[reading.lastMode]?.heading;
  $('#reading-location').textContent = reading.status === 'finished' ? '这一篇，读完了。' : heading ? `上次读到 · ${heading}` : reading.status === 'reading' ? `已读至 ${reading.progress}% · 下次自动继续` : '阅读位置会自动保存';
  $('#finish-reading').textContent = reading.status === 'finished' ? '重新阅读' : '标记为已读完';
}
function persistReading(article, { keepalive = false } = {}) {
  if (article.id === 'empty' || !readingStates.has(article.id) || savedReadingStates.get(article.id) === readingState(article)) return;
  if (keepalive) {
    api(`/api/articles/${article.id}`, { method: 'PATCH', keepalive: true, body: JSON.stringify({ reading: readingState(article) }) }).catch(() => {});
    return;
  }
  if (readingSaves.has(article.id)) return readingSaves.get(article.id);
  const task = (async () => {
    try {
      while (savedReadingStates.get(article.id) !== readingState(article)) {
        const snapshot = readingState(article);
        const updated = await api(`/api/articles/${article.id}`, { method: 'PATCH', body: JSON.stringify({ reading: snapshot }) });
        savedReadingStates.set(article.id, snapshot);
        if (readingState(article) === snapshot) {
          Object.assign(snapshot, updated.reading);
          rememberReading(article, snapshot);
        }
      }
    } catch { toast('阅读进度已暂存到此浏览器，写入文章库失败；下次阅读时会重试。'); }
    finally { readingSaves.delete(article.id); }
  })();
  readingSaves.set(article.id, task); return task;
}
function toast(message, action) {
  const element = $('#toast');
  element.replaceChildren(document.createTextNode(message));
  if (action) {
    const button = document.createElement('button'); button.textContent = action.label;
    button.addEventListener('click', async () => { button.disabled = true; await action.run(); });
    element.append(button);
  }
  element.hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, action ? 12000 : 4500);
}
async function api(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new Error('无法连接拾页，请确认本机服务仍在运行。'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('服务返回异常，请刷新后重试。'); }
  if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
  return result;
}
function setLibraryOpen(open) {
  document.body.classList.toggle('library-open', open);
  $('#sidebar-toggle').setAttribute('aria-expanded', String(open));
}
function setImportOpen(open, focus = false) {
  const shown = open || selected.id === 'empty';
  $('#import-section').hidden = !shown;
  $('#import-toggle').setAttribute('aria-expanded', String(shown));
  if (shown && focus) $('#article-input').focus({ preventScroll: true });
}
function renderLibrary() {
  $('#article-count').textContent = articles.length;
  $('#star-count').textContent = articles.filter(a => a.starred).length;
  const query = $('#library-search').value.trim().toLocaleLowerCase();
  const scoped = articles.filter(a => filter !== 'starred' || a.starred);
  const statusCounts = { all: scoped.length, unread: 0, reading: 0, finished: 0 };
  for (const article of scoped) statusCounts[readingState(article).status] = (statusCounts[readingState(article).status] || 0) + 1;
  for (const [status, count] of Object.entries(statusCounts)) {
    const target = $(`[data-status-count="${status}"]`);
    if (target) target.textContent = count;
  }
  const visible = scoped.filter(a => (statusFilter === 'all' || readingState(a).status === statusFilter) && (!query || `${a.title} ${a.original} ${a.translated}`.toLocaleLowerCase().includes(query)));
  const list = $('#article-list'); list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'library-empty';
    empty.textContent = query ? '没有找到文章' : statusFilter !== 'all' ? '这个状态下还没有文章' : filter === 'starred' ? '还没有收藏' : '书架还空着';
    list.append(empty);
  }
  for (const article of visible) {
    const row = document.createElement('div'); row.className = 'article-row';
    const button = document.createElement('button'); button.className = `article-item${selected.id === article.id ? ' active' : ''}`;
    button.title = article.title; button.dataset.articleId = article.id;
    const title = document.createElement('strong'); title.textContent = displayTitle(article);
    const meta = document.createElement('small');
    const status = { translating: '翻译中', error: '待重试', ready: '已翻译', original: '原文已保存' }[article.status] || '';
    meta.textContent = `${article.siteName || '导入文章'} · ${status}`;
    const reading = document.createElement('span'); reading.className = 'article-reading'; reading.dataset.status = readingState(article).status; reading.textContent = readingLabel(article);
    button.append(title, reading);
    const heading = readingState(article).positions[readingState(article).lastMode]?.heading;
    if (heading && readingState(article).status === 'reading') {
      const chapter = document.createElement('span'); chapter.className = 'article-chapter'; chapter.textContent = `读到：${heading}`; chapter.title = heading; button.append(chapter);
    }
    button.append(meta); button.addEventListener('click', () => { selectArticle(article); $('#article').focus({ preventScroll: true }); });
    const actions = document.createElement('div'); actions.className = 'article-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '文章操作');
    const star = document.createElement('button'); star.className = 'article-action article-star'; star.dataset.starId = article.id;
    star.textContent = article.starred ? '★' : '☆'; star.title = article.starred ? '取消收藏' : '收藏';
    star.setAttribute('aria-label', `${article.starred ? '取消收藏' : '收藏'}《${displayTitle(article)}》`); star.setAttribute('aria-pressed', String(Boolean(article.starred)));
    star.disabled = savingStars.has(article.id) || deletingArticles.has(article.id);
    star.addEventListener('click', () => toggleStar(article));
    const download = document.createElement('button'); download.className = 'article-action'; download.textContent = '↓'; download.title = '下载 Markdown';
    download.setAttribute('aria-label', `下载《${displayTitle(article)}》的 Markdown`);
    download.addEventListener('click', () => exportArticle(article, article.id === selected.id ? mode : article.translated ? 'translated' : 'original'));
    const remove = document.createElement('button'); remove.className = 'article-action article-delete';
    remove.setAttribute('aria-label', `删除《${displayTitle(article)}》`);
    remove.title = article.status === 'translating' ? '翻译完成后可删除' : '删除文章';
    remove.disabled = article.status === 'translating' || deletingArticles.has(article.id);
    remove.innerHTML = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M8 2.5h4l1 2.5H7l1-2.5ZM5 5l1 12h8l1-12M8 8v6M12 8v6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    remove.addEventListener('click', () => deleteArticle(article));
    actions.append(star, download, remove); row.append(button, actions); list.append(row);
  }
}
function withTitle(content, title) { return /^\s*#\s/m.test(content) ? content : `# ${title.replace(/[\r\n]/g, ' ')}\n\n${content}`; }
function linkArticleTitles(container, sourceURL) {
  let url;
  try { url = new URL(sourceURL); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  for (const heading of container.querySelectorAll('h1')) {
    for (const existing of heading.querySelectorAll('a')) existing.replaceWith(...existing.childNodes);
    const link = document.createElement('a');
    link.className = 'article-source-link'; link.href = url.href;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = '打开原文';
    link.append(...heading.childNodes); heading.append(link);
  }
}
function normalizeArticleImages(container) {
  const webURL = value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null; }
    catch { return null; }
  };
  for (const link of container.querySelectorAll('p > a:only-child')) {
    const url = webURL(link.getAttribute('href'));
    if (!url || link.closest('pre, code') || link.parentElement.textContent.trim() !== link.textContent.trim()
      || link.textContent.trim() !== link.getAttribute('href') || link.children.length
      || !/\.(?:png|jpe?g|gif|webp|avif)(?:$)/i.test(url.pathname)) continue;
    const image = document.createElement('img'); image.src = url.href; image.alt = '';
    link.replaceChildren(image);
  }
  for (const image of container.querySelectorAll('img')) {
    if (image.closest('pre, code')) continue;
    let link = image.closest('a');
    const addresses = new Set([image.getAttribute('src'), link?.getAttribute('href')].filter(Boolean));
    if (link) {
      for (const node of [...link.childNodes]) {
        if (node.nodeType === Node.TEXT_NODE && addresses.has(node.textContent.trim())) node.remove();
      }
    }
    const block = image.closest('p, figure');
    if (!block) continue;
    for (const node of [...block.childNodes]) {
      if ((node.nodeType === Node.TEXT_NODE || (node.nodeName === 'A' && !node.querySelector('img')))
        && addresses.has(node.textContent.trim())) node.remove();
    }
    if (!block.textContent.trim() && block.querySelectorAll('img').length === 1) {
      for (const sibling of [block.previousElementSibling, block.nextElementSibling]) {
        if (sibling?.tagName === 'P' && !sibling.querySelector('img, code') && addresses.has(sibling.textContent.trim())) sibling.remove();
      }
    }
    if (!link && (webURL(image.getAttribute('src')) || /^\/media\/[a-f0-9-]+\/[a-f0-9]+\/translated\.(png|jpg|gif|webp|avif|svg)$/.test(image.getAttribute('src')))) {
      link = document.createElement('a'); link.href = image.getAttribute('src');
      image.replaceWith(link); link.append(image);
    }
    if (link && !link.textContent.trim() && !image.alt) link.setAttribute('aria-label', '查看图片');
  }
}
function normalizeArticleNotes(container, sourceURL) {
  for (const paragraph of container.querySelectorAll('p')) {
    const next = paragraph.nextElementSibling;
    if (!paragraph.children.length && paragraph.textContent.trim() === '['
      && next?.tagName === 'P' && next.firstChild?.nodeType === Node.TEXT_NODE
      && /^\s*\d+\]\s+\S/.test(next.firstChild.textContent)) {
      next.prepend(...paragraph.childNodes);
      paragraph.remove();
    }
  }
  for (const link of container.querySelectorAll('p a[href]')) {
    const number = link.textContent.trim();
    if (!/^\d+$/.test(number) || link.closest('pre, code')) continue;
    try {
      const source = new URL(sourceURL || window.location.href); source.hash = '';
      const target = new URL(link.getAttribute('href'), source);
      if (target.hash !== `#f${number}n`) continue;
      target.hash = '';
      if (target.href !== source.href) continue;
    } catch { continue; }
    let reference = link.closest('sup');
    if (!reference) {
      const before = link.previousSibling, after = link.nextSibling;
      if (before?.nodeType !== Node.TEXT_NODE || after?.nodeType !== Node.TEXT_NODE
        || !before.textContent.endsWith('[') || !after.textContent.startsWith(']')) continue;
      before.textContent = before.textContent.slice(0, -1);
      after.textContent = after.textContent.slice(1);
      reference = document.createElement('sup');
      link.replaceWith(reference); reference.append('[', link, ']');
    }
    if (reference.textContent !== `[${number}]`) continue;
    reference.classList.add('article-note-ref');
    const paragraph = reference.parentElement, previous = paragraph.previousElementSibling;
    if (paragraph.tagName === 'P' && paragraph.children.length === 1
      && paragraph.textContent.trim() === reference.textContent && previous?.tagName === 'P'
      && previous.textContent.trim()) {
      previous.append(reference); paragraph.remove();
    }
  }
}
function markdown(content, sourceURL) {
  const html = DOMPurify.sanitize(articleMarkdown.parse(content || '', { gfm: true, breaks: false }), {
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'button', 'textarea', 'select', 'video', 'audio', 'svg', 'math'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
  const container = document.createElement('div'); container.innerHTML = html;
  normalizeArticleNotes(container, sourceURL);
  normalizeArticleImages(container);
  for (const a of container.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  for (const img of container.querySelectorAll('img')) { img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; }
  return container;
}
function renderArticle() {
  outlineObserver?.disconnect();
  renderReadingState();
  const empty = selected.id === 'empty';
  $('.reader-shell').hidden = empty;
  if (empty) {
    leaveFocus(); closeOutline();
    document.body.classList.remove('has-article');
    $('#article').replaceChildren(); $('#outline').replaceChildren();
    $('#breadcrumb-title').textContent = '书架还空着';
    document.title = '拾页 · 开始一篇新的阅读';
    $('#article-meta').replaceChildren(); setImportOpen(true);
    return;
  }
  document.body.classList.add('has-article');
  const article = $('#article'); article.replaceChildren();
  const hasTranslation = Boolean(selected.translated);
  const source = withTitle(selected.original || '', selected.title);
  const translated = withTitle(selected.translated || selected.original || '', displayTitle(selected));
  if (mode === 'parallel' && hasTranslation) {
    const columns = document.createElement('div'); columns.className = 'parallel-columns';
    for (const [label, content, lang] of [[`译文 · ${languageOf(selected).label}`, translated, languageOf(selected).code], ['原文', source, '']]) {
      const column = document.createElement('section'); column.className = 'parallel-side';
      if (lang) column.lang = lang;
      const caption = document.createElement('div'); caption.className = 'parallel-label'; caption.textContent = label;
      column.append(caption, ...markdown(content, selected.sourceURL).childNodes); columns.append(column);
    }
    article.append(columns);
  } else article.append(...markdown(mode === 'original' || !hasTranslation ? source : translated, selected.sourceURL).childNodes);
  // Lets the browser pick fonts and hyphenation for the language actually shown.
  if (mode === 'translated' && hasTranslation) article.lang = languageOf(selected).code; else article.removeAttribute('lang');
  linkArticleTitles(article, selected.sourceURL);
  const meta = $('#article-meta'); meta.replaceChildren();
  const dash = document.createElement('span'); dash.className = 'meta-line'; meta.append(dash);
  const name = document.createElement(selected.sourceURL ? 'a' : 'span');
  name.textContent = selected.siteName || '导入文章';
  if (selected.sourceURL) { name.href = selected.sourceURL; name.target = '_blank'; name.rel = 'noopener noreferrer'; name.textContent += ' ↗'; }
  meta.append(name);
  const readingOriginal = mode === 'original' || !hasTranslation;
  const minutes = Math.max(1, Math.ceil((readingOriginal ? selected.original.length : selected.translated.length) / (readingOriginal ? 1100 : 500)));
  const duration = document.createElement('span'); duration.textContent = `· 约 ${minutes} 分钟`;
  meta.append(duration);
  if (selected.author) { const author = document.createElement('span'); author.textContent = `· ${selected.author}`; meta.append(author); }
  updateTranslatedImages();
  renderArticleNotice();
  $('#breadcrumb-title').textContent = displayTitle(selected);
  document.title = `${displayTitle(selected)} · 拾页`;
  $$('[data-mode]').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); });
  renderOutline();
}
function updateTranslatedImages() {
  if (mode === 'original' || !selected.translated) return;
  const container = mode === 'parallel' ? $('#article .parallel-side') : $('#article');
  for (const image of container?.querySelectorAll('img') || []) {
    const source = image.dataset.sourceImage || image.getAttribute('src');
    let normalizedSource = source;
    try { normalizedSource = new URL(source, window.location.origin).href; } catch {}
    const item = selected.imageTranslation?.items?.find(item => item.source === source || item.source === normalizedSource || item.url === source);
    if (item?.status !== 'done' || !/^\/media\/[a-f0-9-]+\/[a-f0-9]+\/translated\.(png|jpg|gif|webp|avif|svg)$/.test(item.url)) continue;
    image.dataset.sourceImage = item.source;
    image.removeAttribute('srcset'); image.removeAttribute('sizes');
    const target = image.dataset.showOriginal === 'true' ? item.source : item.url;
    if (image.getAttribute('src') !== target) image.src = target;
    image.title = 'AI 重绘的译图，可切换查看原图';
    const link = image.closest('a');
    if (link) link.href = target;
    if (item.insight?.scene) showImageControls(container, image, item);
  }
}
function showImageControls(container, image, item) {
  if ([...container.querySelectorAll('.image-controls')].some(element => element.dataset.source === item.source)) return;
  const controls = document.createElement('div'); controls.className = 'image-controls'; controls.dataset.source = item.source;
  const label = document.createElement('span'); label.hidden = true;
  const toggle = document.createElement('button'); toggle.textContent = '查看原图'; toggle.setAttribute('aria-pressed', 'false');
  toggle.addEventListener('click', () => {
    const original = image.dataset.showOriginal !== 'true';
    if (!original) { label.hidden = true; label.textContent = ''; }
    image.dataset.showOriginal = String(original); image.src = original ? item.source : item.url;
    const link = image.closest('a'); if (link) link.href = image.src;
    toggle.textContent = original ? '查看译图' : '查看原图'; toggle.setAttribute('aria-pressed', String(original));
  });
  image.addEventListener('error', () => {
    if (image.dataset.showOriginal === 'true') return;
    image.dataset.showOriginal = 'true'; image.src = item.source;
    const link = image.closest('a'); if (link) link.href = item.source;
    label.hidden = false; label.textContent = '译图加载失败，已显示原图'; toggle.textContent = '重试译图'; toggle.setAttribute('aria-pressed', 'true');
  });
  controls.append(label, toggle); (image.closest('p, figure') || image.closest('a') || image).after(controls);
}
function renderArticleNotice() {
  const notice = $('#article-notice'); notice.replaceChildren(); notice.hidden = true;
  const info = document.createElement('span');
  if (!selected.translated) {
    notice.hidden = selected.status === 'translating';
    info.textContent = selected.error || '原文已保存，还没有译文。'; notice.append(info);
    if (selected.status !== 'translating') {
      const retry = document.createElement('button'); retry.textContent = '重试翻译'; retry.disabled = busy;
      retry.addEventListener('click', retryTranslation); notice.append(' ', retry);
    }
    return;
  }
  const state = selected.imageTranslation;
  if (state?.status === 'disabled') {
    notice.hidden = false; info.textContent = state.reason || '图片重绘未启用，已保留原图。'; notice.append(info);
    const configure = document.createElement('button'); configure.textContent = modelReport?.imageReady ? '重绘图片' : '配置图片接入';
    configure.addEventListener('click', async () => {
      if (!modelReport?.imageReady) { openModelSetup(); return; }
      configure.disabled = true;
      try { await api(`/api/articles/${selected.id}/images`, { method: 'POST', body: JSON.stringify({ redraw: true }) }); await refreshArticles(); selected = articles.find(article => article.id === selected.id) || selected; renderArticleNotice(); }
      catch (error) { toast(error.message); }
      finally { configure.disabled = false; }
    });
    notice.append(' ', configure); return;
  }
  const pending = ['queued', 'running'].includes(state?.status);
  const failed = state?.status === 'error';
  const needsRedraw = state?.items?.some(item => item.status === 'done' && !item.redrawAttempted && !item.insight?.scene && item.insight?.kind !== 'photo' && !item.url);
  const canStart = (!state || needsRedraw) && $('#article img');
  if (!pending && !failed && !canStart) return;
  notice.hidden = false;
  const completed = state?.items?.filter(item => ['done', 'skipped'].includes(item.status)).length || 0;
  const running = state?.items?.filter(item => item.status === 'running') || [];
  const queued = state?.items?.filter(item => item.status === 'queued').length || 0;
  const stages = { starting: '准备处理', preparing: '准备识别', downloading: '下载原图', recognizing: '识别与排版', waiting: '等待复用结果', replaying: '重放已有结果', validating: '校验结果', rendering: '绘制译图' };
  const details = [...new Set(running.map(item => stages[item.stage]).filter(Boolean))];
  const elapsed = state?.startedAt ? Math.floor((Date.now() - Date.parse(state.startedAt)) / 1000) : NaN;
  const duration = Number.isFinite(elapsed) && elapsed >= 0 ? `，已用 ${elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}` : '';
  info.textContent = pending ? `正文已译好，图片后台解读中 · ${completed} / ${state.items.length}，完成后将以重绘的译图替换原图。`
    : failed ? state.error || '部分图片解读失败，已保留原图；正文可正常阅读。' : '可按原图的配色与布局把图中文字重绘为译文，并随时切回原图。';
  if (pending) info.textContent += ` ${running.length} 张处理中${queued ? `，${queued} 张排队` : ''}${details.length ? ` · ${details.join(' / ')}` : ''}${duration}。`;
  if (pending && state.errorCode === 'IMAGE_RATE_LIMIT') info.textContent += ' 已达到调用频率限制，排队任务暂停，等待已开始的请求完成。';
  if (failed && state.items?.some(item => item.errorCode === 'IMAGE_VALIDATION')) info.textContent += ' 已保存识别结果，重试会先尝试本地重放。';
  notice.append(info);
  if (!pending) {
    const retry = document.createElement('button'); retry.textContent = failed ? '重试图片重绘' : '按原图重绘';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      const id = selected.id;
      try {
        await api(`/api/articles/${id}/images`, { method: 'POST', body: JSON.stringify({ redraw: true }) });
        await refreshArticles();
        if (selected.id === id) { selected = articles.find(article => article.id === id) || selected; renderArticleNotice(); }
      } catch (error) { toast(error.message); }
      finally { retry.disabled = false; }
    });
    notice.append(' ', retry);
  }
}
function scheduleImagePoll() {
  if (imagePollTimer !== null || !articles.some(article => ['queued', 'running'].includes(article.imageTranslation?.status))) return;
  imagePollTimer = setTimeout(async () => {
    imagePollTimer = null;
    try {
      await refreshArticles();
      const current = articles.find(article => article.id === selected.id);
      if (current) { selected = current; updateTranslatedImages(); renderArticleNotice(); }
    } catch { scheduleImagePoll(); }
  }, 1800);
}
function renderOutline() {
  const outline = $('#outline'); outline.replaceChildren();
  const headings = [...$('#article').querySelectorAll('h2,h3,h4,h5,h6')].filter(h => !h.closest('.parallel-side') || h.closest('.parallel-side') === $('.parallel-side'));
  const anchors = [];
  headings.forEach((heading, i) => {
    heading.id = `section-${i}`;
    const link = document.createElement('a'); link.href = `#${heading.id}`; link.textContent = heading.textContent;
    if (Number(heading.tagName.slice(1)) > 2) link.className = 'nested';
    if (i === 0) link.classList.add('active');
    outline.append(link); anchors.push(link);
  });
  if (!headings.length) { const p = document.createElement('span'); p.textContent = '暂无目录'; p.style.cssText = 'font-size:10px;color:var(--muted)'; outline.append(p); }
  outlineObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible.length) anchors.forEach(a => a.classList.toggle('active', a.hash === `#${visible[0].target.id}`));
  }, { rootMargin: '-80px 0px -60% 0px' });
  headings.forEach(h => outlineObserver.observe(h));
}
function savePosition({ keepalive = false } = {}) {
  clearTimeout(scrollTimer);
  if (selected.id === 'empty') return;
  if (!restoringPosition && Math.abs(window.scrollY - lastScrollY) > 1) {
    const article = $('#article');
    const rect = article.getBoundingClientRect();
    if (rect.height > 0) {
      const top = rect.top + window.scrollY;
      const distance = Math.max(1, rect.height - window.innerHeight + 80);
      const progress = Math.round(Math.max(0, Math.min(1, (window.scrollY - top) / distance)) * 100);
      const headings = [...article.querySelectorAll('h2,h3,h4,h5,h6')].filter(h => !h.closest('.parallel-side') || h.closest('.parallel-side') === $('.parallel-side'));
      const heading = headings.filter(h => h.getBoundingClientRect().top <= 110).at(-1)?.textContent.trim().slice(0, 250) || '';
      const previous = readingState(selected);
      const reading = { ...previous, status: previous.status === 'finished' ? 'finished' : 'reading', updatedAt: new Date().toISOString(),
        progress: previous.status === 'finished' ? 100 : Math.min(99, progress), lastMode: mode, lastReadAt: new Date().toISOString(),
        positions: { ...previous.positions, [mode]: { scrollY: Math.max(0, window.scrollY), progress, heading } } };
      rememberReading(selected, reading);
      saveSetting(`scroll.${selected.id}.${mode}`, String(window.scrollY));
      renderLibrary(); renderReadingState();
    }
    lastScrollY = window.scrollY;
  }
  return persistReading(selected, { keepalive });
}
function restorePosition(article) {
  const version = ++restoreVersion;
  restoringPosition = true;
  const position = readingState(article).positions[mode]?.scrollY ?? Number(readSetting(`scroll.${article.id}.${mode}`, '0'));
  requestAnimationFrame(() => {
    if (version !== restoreVersion) return;
    window.scrollTo({ top: Number.isFinite(position) ? Math.max(0, position) : 0, behavior: 'instant' });
    lastScrollY = window.scrollY;
    requestAnimationFrame(() => { if (version === restoreVersion) restoringPosition = false; });
  });
}
function setReadingStatus(status) {
  if (selected.id === 'empty') return;
  savePosition();
  const previous = readingState(selected);
  const reading = status === 'unread'
    ? { status, progress: 0, positions: {}, lastMode: mode, lastReadAt: null, finishedAt: null, updatedAt: new Date().toISOString() }
    : { ...previous, status, progress: status === 'finished' ? 100 : Math.min(99, previous.positions[previous.lastMode]?.progress || 0),
      lastReadAt: new Date().toISOString(), finishedAt: status === 'finished' ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
  rememberReading(selected, reading);
  if (status === 'unread') {
    for (const value of ['translated', 'original', 'parallel']) saveSetting(`scroll.${selected.id}.${value}`, '0');
    restorePosition(selected);
  }
  renderLibrary(); renderReadingState(); persistReading(selected);
}
function selectArticle(article, { scroll = true } = {}) {
  savePosition(); selected = article; saveSetting('selected', article.id); renderLibrary(); renderArticle();
  if (article.id !== 'empty') setImportOpen(false);
  if (matchMedia('(max-width:680px)').matches) setLibraryOpen(false);
  if (scroll) restorePosition(article);
}
async function deleteArticle(article) {
  if (deletingArticles.has(article.id)) return;
  deletingArticles.add(article.id); renderLibrary();
  try {
    const index = articles.findIndex(item => item.id === article.id);
    const wasSelected = selected.id === article.id;
    await api(`/api/articles/${article.id}`, { method: 'DELETE' });
    articles = articles.filter(item => item.id !== article.id);
    if (wasSelected) selectArticle(articles[Math.min(index, articles.length - 1)] || emptyArticle, { scroll: false });
    else renderLibrary();
    toast('文章已删除', { label: '撤销', run: async () => {
      try {
        const restored = await api(`/api/articles/${article.id}/restore`, { method: 'POST' });
        await refreshArticles();
        if (wasSelected) selectArticle(restored, { scroll: false });
        toast('文章已恢复。');
      } catch (error) { toast(error.message); }
    } });
  } catch (error) { toast(error.message); }
  finally { deletingArticles.delete(article.id); renderLibrary(); }
}
async function refreshArticles() {
  articles = await api('/api/articles');
  for (const article of articles) {
    if (!readingStates.has(article.id)) {
      let cached;
      try { cached = JSON.parse(readSetting(`reading.${article.id}`, 'null')); } catch {}
      const server = readingState(article);
      const localIsNewer = cached && ['unread', 'reading', 'finished'].includes(cached.status) && cached.positions
        && ['translated', 'original', 'parallel'].includes(cached.lastMode)
        && Date.parse(cached.updatedAt || cached.lastReadAt) > (Date.parse(server.updatedAt || server.lastReadAt) || 0);
      const reading = localIsNewer ? cached : server;
      readingStates.set(article.id, reading);
      if (!localIsNewer) savedReadingStates.set(article.id, reading);
    }
    article.reading = readingState(article);
  }
  renderLibrary(); scheduleImagePoll();
}
function setBusy(value) { busy = value; for (const id of ['#import-button', '#article-input', '#new-article', '#import-toggle', '#markdown-file', '#paste-clipboard', '#target-language']) $(id).disabled = value || (id === '#import-button' && !providerAvailable); }
function showJob(job) {
  saveSetting('lastJob', JSON.stringify({ status: job.status, message: job.message, progress: job.progress || 0, fetchFailed: job.fetchFailed, sourceURL: job.sourceURL }));
  $('#job-status').hidden = false; $('#job-status').classList.toggle('error', job.status === 'error');
  $('#job-message').textContent = job.message;
  $('#job-progress').value = job.progress || 0;
  $('#job-progress').hidden = ['done', 'error'].includes(job.status);
  $('#dismiss-status').hidden = !['done', 'error'].includes(job.status);
  // A page the program could not read is usually readable in the user's own browser.
  const fallback = job.status === 'error' && job.fetchFailed;
  $('#job-actions').hidden = !fallback;
  $('#job-open-source').hidden = !(fallback && /^https?:\/\//.test(job.sourceURL || ''));
  if (fallback && job.sourceURL) $('#job-open-source').href = job.sourceURL;
}
async function trackJob(id) {
  activeJob = id; saveSetting('job', id); setBusy(true);
  let trackedArticleId = null;
  try {
    while (activeJob === id) {
      const job = await api(`/api/jobs/${id}`); showJob(job);
      if (job.articleId && trackedArticleId !== job.articleId) {
        trackedArticleId = job.articleId;
        await refreshArticles(); const current = articles.find(a => a.id === job.articleId);
        if (current && (selected.id === 'empty' || selected.id === current.id)) selectArticle(current, { scroll: false });
      }
      if (['done', 'error'].includes(job.status)) {
        await refreshArticles(); const current = articles.find(a => a.id === job.articleId);
        if (current && selected.id === current.id) { if (job.status === 'done') mode = 'translated'; selectArticle(current, { scroll: false }); }
        if (job.status === 'done') { $('#article-input').value = ''; setImportOpen(false); $('#job-status').hidden = true; toast('译文已保存'); }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  } catch (error) {
    showJob({ status: 'error', message: error.message });
    await refreshArticles().catch(() => {});
  } finally {
    activeJob = null; saveSetting('job', ''); setBusy(false);
    if (selected.id === trackedArticleId) renderArticle();
  }
}
async function startImport(payload) {
  if (busy) { toast('这一篇正在翻译，稍等片刻。'); return; }
  setBusy(true); showJob({ status: 'running', message: '开始处理文章…', progress: 0 });
  try { const job = await api('/api/import', { method: 'POST', body: JSON.stringify({ ...payload, provider: $('#provider').value, targetLanguage: $('#target-language').value }) }); await trackJob(job.id); }
  catch (error) { showJob({ status: 'error', message: error.message }); setBusy(false); }
}
async function retryTranslation() {
  if (busy || selected.id === 'empty') return;
  try { const job = await api(`/api/articles/${selected.id}/translate`, { method: 'POST', body: JSON.stringify({ provider: $('#provider').value, targetLanguage: $('#target-language').value }) }); await trackJob(job.id); }
  catch (error) { toast(error.message); }
}
async function toggleStar(article) {
  if (savingStars.has(article.id)) return;
  savingStars.add(article.id);
  try {
    const updated = await api(`/api/articles/${article.id}`, { method: 'PATCH', body: JSON.stringify({ starred: !article.starred }) });
    updated.reading = readingState(article);
    articles = articles.map(item => item.id === updated.id ? updated : item);
    if (selected.id === updated.id) { selected = updated; renderArticle(); }
  } catch (error) { toast(error.message); }
  finally { savingStars.delete(article.id); renderLibrary(); document.querySelector(`[data-star-id="${article.id}"]`)?.focus({ preventScroll: true }); }
}
function exportArticle(article, exportMode) {
  let translated = article.translated;
  for (const item of article.imageTranslation?.items || []) {
    if (item.status === 'done' && /^\/media\//.test(item.url)) translated = translated.replaceAll(item.url, new URL(item.url, window.location.origin).href);
  }
  if (translated) translated += imageInsights.imageInsightsMarkdown(article.imageTranslation?.items);
  const content = exportMode === 'original' ? withTitle(article.original, article.title) : exportMode === 'parallel' ? `# ${displayTitle(article)}\n\n## 译文（${languageOf(article).label}）\n\n${translated || '尚无译文'}\n\n---\n\n## 原文\n\n${article.original}` : withTitle(translated || article.original, displayTitle(article));
  const source = article.sourceURL ? `\n\n---\n\n原文：${article.sourceURL}\n` : '';
  const url = URL.createObjectURL(new Blob([content + source], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${(exportMode === 'original' ? article.title : displayTitle(article)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100)}${exportMode === 'original' ? '-原文' : exportMode === 'parallel' ? '-双语' : `-${languageOf(article).label}`}.md`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
function closePanel(id, toggle) { $(id).hidden = true; $(toggle).setAttribute('aria-expanded', 'false'); }
function closeOutline() { document.body.classList.remove('outline-open'); }
function fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
function focusModeActive() { return document.body.classList.contains('focus-mode'); }
function setFocusMode(active) {
  document.body.classList.toggle('focus-mode', active);
  const toggle = $('#focus-toggle');
  toggle.setAttribute('aria-pressed', String(active));
  toggle.setAttribute('aria-label', active ? '退出全屏' : '全屏阅读');
  toggle.title = active ? '退出全屏 · Esc' : '全屏阅读';
  $('#focus-exit').hidden = !active;
}
function leaveFocus() {
  setFocusMode(false);
  if (!fullscreenElement()) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try { const result = exit.call(document); result?.catch?.(() => {}); } catch {}
}
async function enterFocus() {
  if (focusModeActive()) return;
  if (selected.id === 'empty') { openImport(); return; }
  setFocusMode(true);
  setLibraryOpen(false); setImportOpen(false);
  closePanel('#reading-settings', '#settings-toggle'); closeOutline();
  $('#article').focus({ preventScroll: true });
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!request) { toast('这个浏览器无法隐藏浏览器界面，已进入专注阅读 · Esc 退出'); return; }
  try {
    // 全屏请求必须紧跟点击；成功后浏览器标签栏、地址栏都会隐藏，只留正文。
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else request.call(root);
  } catch {
    if (!fullscreenElement()) toast('浏览器没有允许全屏，已进入专注阅读 · Esc 退出');
  }
}
function toggleFocus() {
  if (focusModeActive() || fullscreenElement()) leaveFocus(); else enterFocus();
}
document.addEventListener('fullscreenchange', () => setFocusMode(Boolean(fullscreenElement())));
document.addEventListener('webkitfullscreenchange', () => setFocusMode(Boolean(fullscreenElement())));
function openImport() {
  leaveFocus(); closeOutline();
  setLibraryOpen(false); setImportOpen(true, true);
}
$('#import-form').addEventListener('submit', event => { event.preventDefault(); startImport({ content: $('#article-input').value }); });
$('#import-form').addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); $('#import-form').requestSubmit(); } });
$('#new-article').addEventListener('click', openImport);
$('#provider').addEventListener('change', () => saveSetting('provider', $('#provider').value));
$('#target-language').replaceChildren(...languages.map(({ code, label }) => { const option = document.createElement('option'); option.value = code; option.textContent = label; return option; }));
$('#target-language').value = findLanguage(readSetting('targetLanguage', ''))?.code || languageFromLocale(navigator.language) || defaultLanguage;
$('#target-language').addEventListener('change', () => saveSetting('targetLanguage', $('#target-language').value));
async function pasteClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { toast('剪贴板是空的'); return false; }
    $('#article-input').value = text.trim();
    $('#article-input').dispatchEvent(new Event('input'));
    $('#article-input').focus();
    toast('已粘贴，点“开始阅读”');
    return true;
  } catch { toast('浏览器没有允许读取剪贴板，请在输入框里直接粘贴'); $('#article-input').focus(); return false; }
}
$('#paste-clipboard').addEventListener('click', pasteClipboard);
$('#job-paste').addEventListener('click', () => { openImport(); pasteClipboard(); });
$('#import-toggle').addEventListener('click', () => { if ($('#import-section').hidden) openImport(); else setImportOpen(false); });
$('#sidebar-toggle').addEventListener('click', () => { leaveFocus(); setLibraryOpen(!document.body.classList.contains('library-open')); });
$('#library-close').addEventListener('click', () => { setLibraryOpen(false); $('#sidebar-toggle').focus({ preventScroll: true }); });
$('#search-toggle').addEventListener('click', () => { $('#library-search').hidden = !$('#library-search').hidden; if (!$('#library-search').hidden) $('#library-search').focus(); });
$('#library-search').addEventListener('input', renderLibrary);
$('#reading-status').addEventListener('change', event => setReadingStatus(event.target.value));
$('#finish-reading').addEventListener('click', () => setReadingStatus(readingState(selected).status === 'finished' ? 'unread' : 'finished'));
$$('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  $$('[data-filter]').forEach(b => { const active = b === button; b.classList.toggle('active', active); b.setAttribute('aria-current', String(active)); });
  renderLibrary();
}));
$$('[data-status-filter]').forEach(button => button.addEventListener('click', () => {
  statusFilter = button.dataset.statusFilter;
  $$('[data-status-filter]').forEach(b => { const active = b === button; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
  renderLibrary();
}));
$$('[data-mode]').forEach(button => button.addEventListener('click', () => { savePosition(); mode = button.dataset.mode; saveSetting('mode', mode); renderArticle(); restorePosition(selected); }));
$('#dismiss-status').addEventListener('click', () => { $('#job-status').hidden = true; saveSetting('lastJob', ''); });
$('#markdown-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 500_000) { toast('文件较大，请分段导入。'); return; }
  $('#article-input').value = await file.text(); $('#article-input').focus();
});
$('.file-label').addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); $('#markdown-file').click(); } });
$('#focus-toggle').addEventListener('click', toggleFocus);
$('#focus-exit').addEventListener('click', leaveFocus);
$('#settings-toggle').addEventListener('click', () => {
  const open = $('#reading-settings').hidden;
  $('#reading-settings').hidden = !open; $('#settings-toggle').setAttribute('aria-expanded', String(open));
});
$('#outline-edge').addEventListener('click', event => {
  const open = document.body.classList.toggle('outline-open');
  if (!open) event.currentTarget.blur();
});
$('#outline').addEventListener('click', event => {
  if (!event.target.closest('a')) return;
  closeOutline();
  // 默认的锚点跳转结束后再把焦点交给正文，键盘用户不用从页首重新 Tab。
  setTimeout(() => $('#article').focus({ preventScroll: true }), 0);
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.sidebar, #sidebar-toggle')) {
    if ($('.sidebar').contains(document.activeElement)) document.activeElement.blur();
    setLibraryOpen(false);
  }
  if (!event.target.closest('#import-section, #import-toggle, #new-article')) setImportOpen(false);
  if (!event.target.closest('#reading-settings, #settings-toggle')) closePanel('#reading-settings', '#settings-toggle');
  if (!event.target.closest('#outline-panel, #outline-edge')) {
    closeOutline();
    if (document.activeElement === $('#outline-edge') || $('#outline-panel').contains(document.activeElement)) document.activeElement.blur();
  }
});
if (readSetting('appearanceVersion', '') !== 'newsprint-1') {
  saveSetting('theme', 'newsprint');
  saveSetting('#font-size', '16');
  saveSetting('#line-height', '1.5');
  saveSetting('font', 'serif');
  saveSetting('appearanceVersion', 'newsprint-1');
}
function applyTheme(theme) { if (!['newsprint', 'white', 'night'].includes(theme)) theme = 'newsprint'; document.body.dataset.theme = theme; $$('button[data-theme]').forEach(b => b.classList.toggle('active', b.dataset.theme === theme)); saveSetting('theme', theme); }
$$('button[data-theme]').forEach(button => button.addEventListener('click', () => applyTheme(button.dataset.theme)));
applyTheme(readSetting('theme', 'newsprint'));
function applyRange(id, property, unit, fallback) {
  const input = $(id); const value = Number(readSetting(id, String(fallback)));
  input.value = Number.isFinite(value) ? Math.max(Number(input.min), Math.min(Number(input.max), value)) : fallback;
  const apply = () => { document.documentElement.style.setProperty(property, input.value + unit); saveSetting(id, input.value); if (id === '#font-size') $('#font-size-value').textContent = input.value; };
  input.addEventListener('input', apply); apply();
}
applyRange('#font-size', '--body-size', 'px', 16); applyRange('#line-height', '--leading', '', 1.5);
$('#font-family').value = readSetting('font', 'serif');
function applyFont() { const sans = $('#font-family').value === 'sans'; document.documentElement.style.setProperty('--article-font', sans ? '"PingFang SC","Hiragino Sans GB",sans-serif' : '"PT Serif","Songti SC","STSong","Noto Serif CJK SC",Georgia,serif'); saveSetting('font', $('#font-family').value); }
$('#font-family').addEventListener('change', applyFont); applyFont();
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openImport(); }
  if (event.key === 'Escape') {
    leaveFocus(); closeOutline();
    setLibraryOpen(false); setImportOpen(false);
    closePanel('#reading-settings', '#settings-toggle');
    if ($('#outline-edge') === document.activeElement || $('#outline-panel').contains(document.activeElement) || $('.sidebar').contains(document.activeElement)) $('#article').focus({ preventScroll: true });
  }
});
window.addEventListener('scroll', () => { if (restoringPosition) return; clearTimeout(scrollTimer); scrollTimer = setTimeout(savePosition, 350); }, { passive: true });
window.addEventListener('pagehide', () => savePosition({ keepalive: true }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePosition({ keepalive: true }); });
if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
  $$('kbd').forEach(node => { node.textContent = node.textContent.replace(/⌘\s?/g, 'Ctrl+'); });
  $$('[title*="⌘"]').forEach(node => { node.title = node.title.replace(/⌘/g, 'Ctrl+'); });
}
async function init() {
  mode = ['original', 'translated', 'parallel'].includes(readSetting('mode', 'translated')) ? readSetting('mode', 'translated') : 'translated';
  const launch = launchRequest();
  renderLibrary(); renderArticle();
  try {
    await refreshArticles(); const previous = articles.find(a => a.id === readSetting('selected', 'sample'));
    selectArticle(previous || articles[0] || emptyArticle);
    try {
      renderModelSetup(await api('/api/setup'));
      if (!modelReport.textReady && !articles.length && !readSetting('setupDismissed', '')) openModelSetup();
    } catch { $('#connection-summary').textContent = '接入状态无法读取，请确认服务已更新，或重新打开模型接入。'; }
    if (launch.job) trackJob(launch.job);
    else if (launch.pending) {
      openImport();
      $('#article-input').value = launch.pending;
      $('#article-input').dispatchEvent(new Event('input'));
      $('#article-input').focus({ preventScroll: true });
      toast('链接已填入，确认后点“开始阅读”。');
    } else {
      const job = readSetting('job', '');
      if (job) trackJob(job);
      else {
        let lastJob;
        try { lastJob = JSON.parse(readSetting('lastJob', 'null')); } catch {}
        if (lastJob?.status === 'error') showJob(lastJob);
      }
    }
    clearLaunchRequest();
  } catch (error) { toast(error.message); }
}
init();
