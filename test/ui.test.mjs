import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as marked from 'marked';
import createDOMPurify from 'dompurify';
import * as imageInsights from '../lib/image-insights.mjs';
import * as languageModule from '../lib/languages.mjs';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup({ sourceURL, heading, body = '完整的中文正文。', backgroundJob = false, imageTranslation, reading, settings = {}, failReading = false, modelSetup, platform = 'MacIntel', search = '' } = {}) {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/' + search, runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const articles = ['第一篇', '第二篇'].map((title, index) => ({ id: `article-${index}`, title: `Original ${index}`, translatedTitle: title, original: `# Original ${index}\n\nOriginal content.`, translated: `# ${index === 0 && heading ? heading : title}\n\n完整的中文正文。`, sourceURL: sourceURL ?? 'https://example.com/' + index, siteName: 'Example', status: 'ready', starred: false }));
  const requests = [], downloads = [], blobs = [];
  articles[0].translated = `# ${heading || '第一篇'}\n\n${body}`;
  articles[0].original = `# Original 0\n\n${body}`;
  if (imageTranslation) articles[0].imageTranslation = structuredClone(imageTranslation);
  if (reading) articles[0].reading = structuredClone(reading);
  for (const [key, value] of Object.entries(settings)) window.localStorage.setItem(`shiye.${key}`, value);
  window.marked = marked; window.DOMPurify = createDOMPurify(window);
  window.matchMedia = () => ({ matches: false });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.scrollTo = ({ top }) => { window.scrollY = top; };
  window.requestAnimationFrame = callback => { callback(); return 0; };
  window.IntersectionObserver = class { observe() {} disconnect() {} };
  window.Blob = Blob;
  window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:test'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  const pollTimers = [];
  const imagePollTimers = [];
  const setWindowTimeout = window.setTimeout.bind(window);
  if (backgroundJob || imageTranslation) window.setTimeout = (callback, delay, ...args) => {
    if (delay === 1200) { pollTimers.push(callback); return 0; }
    if (delay === 1800) { imagePollTimers.push(callback); return 1; }
    return setWindowTimeout(callback, delay, ...args);
  };
  let jobResult = { status: 'running', articleId: articles[0].id, message: '正在翻译', progress: 30 };
  window.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    let value;
    if (url === '/api/articles') value = articles;
    else if (url === '/api/setup') {
      const config = modelSetup || { settings: { textProvider: 'agy', imageProvider: 'agy', apiBaseURL: '', imageApiBaseURL: '', textModel: '', imageModel: '', apiKeyConfigured: false, imageApiKeyConfigured: false, managedByEnvironment: [] }, textProvider: 'agy', imageProvider: 'agy', textReady: true, imageReady: true, text: { agy: true, codex: true, api: false }, connectionNote: '连接待验证' };
      if (options.method === 'PUT') { Object.assign(config.settings, JSON.parse(options.body)); config.textProvider = config.settings.textProvider; config.text.api = Boolean(config.settings.apiBaseURL && config.settings.textModel); config.textReady = config.text[config.textProvider] === true; }
      value = config;
    }
    else if (url === '/api/setup/models') value = { models: ['model-a', 'model-b'] };
    else if (url === '/api/setup/probe') value = { ok: true, message: '正文连接已验证。' };
    else if (options.method === 'PATCH') {
      const patch = JSON.parse(options.body);
      if (failReading && patch.reading) return { ok: false, json: async () => ({ error: '保存失败' }) };
      const article = articles.find(a => url.endsWith(a.id)); Object.assign(article, patch); value = article;
    }
    else if (url === '/api/import') value = { id: 'test-job' };
    else if (url.startsWith('/api/jobs/')) value = backgroundJob ? jobResult : { status: 'done', articleId: articles[0].id, message: '完成' };
    else if (url === '/api/articles/article-0/images' && options.method === 'POST') {
      articles[0].imageTranslation.status = 'queued'; value = articles[0].imageTranslation;
    }
    else throw new Error('Unexpected test request: ' + url);
    return { ok: true, json: async () => structuredClone(value) };
  };
  window.imageInsights = imageInsights;
  Object.assign(window, languageModule);
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  window.eval((await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace("import * as imageInsights from './image-insights.mjs';", '')
    .replace(/^import \{[^}]+\} from '\.\/languages\.mjs';$/m, ''));
  await flush();
  return { window, document: window.document, dom, requests, downloads, blobs, async pollImages(state) {
    articles[0].imageTranslation = structuredClone(state);
    for (const item of state.items || []) {
      if (item.status === 'done' && item.url) articles[0].translated = articles[0].translated.replaceAll(item.source, item.url);
    }
    assert.equal(imagePollTimers.length, 1); imagePollTimers.shift()(); await flush();
  }, async pollJob(status = 'running') {
    jobResult = { ...jobResult, status };
    assert.equal(pollTimers.length, 1);
    pollTimers.shift()();
    await flush();
  } };
}

for (const outcome of ['done', 'error']) {
  test(`background translation preserves another article and reading mode through ${outcome}`, async () => {
    const app = await setup({ backgroundJob: true });
    try {
      const { document, window } = app;
      document.querySelector('[data-article-id="article-1"]').click();
      document.querySelector('#article-input').value = '# New article\n\nAn article that is long enough to import.';
      document.querySelector('#import-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      assert.equal(document.querySelector('#article h1').textContent, '第二篇');
      document.querySelector('[data-article-id="article-0"]').click();
      document.querySelector('[data-article-id="article-1"]').click();
      document.querySelector('[data-mode="original"]').click();
      const heading = document.querySelector('#article h1');
      assert.equal(heading.textContent, 'Original 1');
      await app.pollJob();
      assert.equal(document.querySelector('#article h1'), heading);
      assert.equal(document.querySelector('#job-status').hidden, false);
      await app.pollJob(outcome);
      assert.equal(document.querySelector('#article h1'), heading);
      assert.equal(document.querySelector('[data-mode="original"]').classList.contains('active'), true);
      assert.equal(document.querySelector('#import-button').disabled, false);
      assert.equal(document.querySelector('#job-status').hidden, outcome === 'done');
    } finally { app.dom.window.close(); }
  });
}

test('model setup saves non-secret API settings and keeps credentials out of browser storage', async () => {
  const modelSetup = { settings: { textProvider: 'api', imageProvider: 'none', apiBaseURL: '', imageApiBaseURL: '', textModel: '', imageModel: '', apiKeyConfigured: true, imageApiKeyConfigured: false, managedByEnvironment: [] }, textProvider: 'api', imageProvider: 'none', textReady: false, imageReady: false, text: { agy: false, codex: false, api: false }, connectionNote: '登录和模型权限待验证' };
  const app = await setup({ modelSetup });
  try {
    const heading = app.document.querySelector('#article h1');
    assert.equal(app.document.querySelector('#import-button').disabled, true);
    assert.equal(app.document.querySelector('#model-setup').open, false);
    app.document.querySelector('#model-setup-toggle').click();
    assert.equal(app.document.querySelector('#model-setup').open, true);
    assert.match(app.document.querySelector('#setup-api-key').placeholder, /已配置/);
    app.document.querySelector('#setup-api-base-url').value = 'https://models.example/v1';
    app.document.querySelector('#setup-fetch-models').click(); await flush();
    assert.equal(app.document.querySelectorAll('#setup-model-options option').length, 2);
    assert.match(app.document.querySelector('#setup-models-status').textContent, /2 个模型/);
    app.document.querySelector('#setup-text-model').value = 'my-text-model';
    app.document.querySelector('#setup-api-key').value = 'ui-secret-fixture';
    app.document.querySelector('#model-setup-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const request = app.requests.find(request => request.url === '/api/setup' && request.options.method === 'PUT');
    assert.equal(JSON.parse(request.options.body).textModel, 'my-text-model');
    assert.equal(JSON.parse(request.options.body).apiKey, 'ui-secret-fixture');
    assert(!JSON.stringify(app.window.localStorage).includes('ui-secret-fixture'));
    assert.equal(app.document.querySelector('#setup-image-fields').hidden, true);
    const imageMode = app.document.querySelector('#setup-image-mode');
    imageMode.value = 'separate'; imageMode.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    assert.equal(app.document.querySelector('#setup-image-fields').hidden, false);
    imageMode.value = 'none'; imageMode.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    assert.equal(app.document.querySelector('#setup-image-fields').hidden, true);
    assert.equal(app.document.querySelector('#setup-api-key').value, '');
    assert.equal(app.document.querySelector('#setup-image-mode').value, 'none');
    assert.equal(app.document.querySelector('#import-button').disabled, false);
    assert.equal(app.document.querySelector('#provider').hidden, true);
    app.document.querySelector('#probe-text').click(); await flush();
    assert.match(app.document.querySelector('#setup-probe-result').textContent, /已验证/);
    app.document.querySelector('#model-setup-done').click();
    assert.equal(app.document.querySelector('#model-setup').open, false);
    assert.equal(app.window.localStorage.getItem('shiye.setupDismissed'), 'yes');
    assert.equal(app.document.querySelector('#article h1'), heading);
  } finally { app.dom.window.close(); }
});

test('model setup closes on a backdrop click but not on a click inside the card', async () => {
  const app = await setup();
  try {
    const { document, window } = app;
    document.querySelector('#model-setup-toggle').click();
    const dialog = document.querySelector('#model-setup');
    assert.equal(dialog.open, true);
    dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 500, width: 400, height: 400, x: 100, y: 100, toJSON() {} });

    dialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 200, clientY: 200 }));
    assert.equal(dialog.open, true);

    dialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 80 }));
    assert.equal(dialog.open, false);
    assert.equal(window.localStorage.getItem('shiye.setupDismissed'), 'yes');
  } finally { app.dom.window.close(); }
});

test('a usable local agent enables import even when the configured API is not ready', async () => {
  const modelSetup = { settings: { textProvider: 'api', imageProvider: 'none', apiBaseURL: '', imageApiBaseURL: '', textModel: '', imageModel: '', apiKeyConfigured: false, imageApiKeyConfigured: false, managedByEnvironment: [] }, textProvider: 'api', imageProvider: 'none', textReady: false, imageReady: false, text: { agy: true, codex: false, api: false }, connectionNote: '登录状态待验证' };
  const app = await setup({ modelSetup });
  try {
    const select = app.document.querySelector('#provider');
    assert.equal(select.hidden, true); assert.equal(select.value, 'agy');
    assert.equal(app.document.querySelector('#import-button').disabled, false);
  } finally { app.dom.window.close(); }
});

test('import provider selector appears only when multiple providers are usable', async () => {
  const app = await setup();
  try {
    const select = app.document.querySelector('#provider');
    assert.equal(select.hidden, false); assert.equal(select.value, 'agy');
    assert.equal(select.querySelector('option[value="api"]').disabled, true);
    assert.equal(select.querySelector('option[value="agy"]').disabled, false);
  } finally { app.dom.window.close(); }
});

test('image URLs render as clickable images and only adjacent duplicate URLs are removed', async () => {
  const imageURL = 'https://example.com/photo.jpg?size=large';
  const mediaURL = 'https://x.com/author/article/123/media/456';
  const body = [
    imageURL,
    `[![](${imageURL})](${mediaURL})`,
    mediaURL,
    `<p><a href="${mediaURL}"><img src="${imageURL}">${mediaURL}</a></p>`,
    `![图片说明](${imageURL}) ${imageURL}`,
    `![保留说明](${imageURL}) 图片来源：[作者网站](https://example.com/credits)`,
    '普通正文中的网址 https://example.com/other.jpg 应保留。',
    'https://example.com/page',
    '`https://example.com/code.jpg`',
    '```html\n<img src="https://example.com/code.jpg">\n```',
  ].join('\n\n');
  const app = await setup({ body });
  try {
    for (const mode of ['translated', 'original', 'parallel']) {
      app.document.querySelector(`[data-mode="${mode}"]`).click();
      const copies = mode === 'parallel' ? 2 : 1;
      const article = app.document.querySelector('#article');
      assert.equal(article.querySelectorAll('img').length, 5 * copies);
      assert.equal(article.querySelectorAll('a > img').length, 5 * copies);
      assert.ok(!article.textContent.includes(imageURL));
      assert.ok(!article.textContent.includes(mediaURL));
      assert.match(article.textContent, /图片来源：作者网站/);
      assert.ok(article.querySelector('a[href="https://example.com/other.jpg"]'));
      assert.ok(article.querySelector('a[href="https://example.com/page"]'));
      assert.match(article.querySelector('pre code').textContent, /<img src=/);
      assert.ok([...article.querySelectorAll('a:has(img)')].every(link => link.target === '_blank'));
    }
  } finally { app.dom.window.close(); }
});

const readingAt = (mode = 'translated', scrollY = 600, heading = '第二节') => ({ status: 'reading', progress: 40,
  positions: { [mode]: { scrollY, progress: 40, heading } }, lastMode: mode, lastReadAt: '2026-10-27T01:00:00.000Z', finishedAt: null });

test('reading states stay visible on the shelf and filters combine with favorites and search', async () => {
  const app = await setup({ reading: readingAt() });
  try {
    const { document, window } = app;
    assert.equal(document.querySelector('[data-article-id="article-0"] .article-reading').textContent, '阅读中 · 40%');
    assert.equal(document.querySelector('.article-chapter').textContent, '读到：第二节');
    assert.equal(window.scrollY, 600);
    assert.equal(document.querySelector('[data-status-count="all"]').textContent, '2');
    assert.equal(document.querySelector('[data-status-count="reading"]').textContent, '1');
    document.querySelector('[data-status-filter="reading"]').click();
    assert.equal(document.querySelectorAll('.article-item').length, 1);
    assert.equal(document.querySelector('[data-status-filter="reading"]').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('[data-status-filter="all"]').getAttribute('aria-pressed'), 'false');
    document.querySelector('[data-filter="starred"]').click();
    assert.equal(document.querySelectorAll('.article-item').length, 0);
    assert.equal(document.querySelector('[data-status-count="all"]').textContent, '0');
    document.querySelector('[data-filter="all"]').click();
    assert.equal(document.querySelector('[data-status-count="all"]').textContent, '2');
    document.querySelector('#library-search').value = '第二篇';
    document.querySelector('#library-search').dispatchEvent(new window.Event('input'));
    assert.equal(document.querySelectorAll('.article-item').length, 0);
  } finally { app.dom.window.close(); }
});

test('the sidebar keeps import, browsing, reading status and the shelf as separate groups', async () => {
  const app = await setup();
  try {
    const { document } = app;
    assert.equal(document.querySelectorAll('.status-option').length, 4);
    assert.equal(document.querySelectorAll('.status-option [data-status-count]').length, 4);
    assert.equal(document.querySelectorAll('.sidebar .library-section').length, 3);
    assert.equal(document.querySelector('.library-nav').getAttribute('aria-label'), '文章分类');
    assert.equal(document.querySelector('.status-filter').getAttribute('aria-label'), '阅读状态');
    assert.equal(document.querySelector('.shelf-section').getAttribute('aria-label'), '文章列表');
    assert.equal(document.querySelectorAll('.sidebar .library-heading').length, 0);
  } finally { app.dom.window.close(); }
});

test('finishing is explicit, persists without rebuilding the article and can reset all positions', async () => {
  const app = await setup({ reading: readingAt() });
  try {
    const { document, window, requests } = app;
    const heading = document.querySelector('#article h1');
    document.querySelector('#finish-reading').click(); await flush();
    assert.equal(document.querySelector('#reading-status').value, 'finished');
    assert.equal(document.querySelector('.article-reading').textContent, '已读完');
    assert.equal(document.querySelector('#article h1'), heading);
    assert.equal(JSON.parse(requests.find(r => r.options.method === 'PATCH').options.body).reading.status, 'finished');
    document.querySelector('#finish-reading').click(); await flush();
    assert.equal(document.querySelector('#reading-status').value, 'unread');
    assert.equal(window.scrollY, 0);
    const reset = JSON.parse(requests.filter(r => r.options.method === 'PATCH').at(-1).options.body).reading;
    assert.deepEqual(reset.positions, {});
    assert.equal(reset.progress, 0);
    document.querySelector('[data-article-id="article-1"]').click();
    document.querySelector('[data-article-id="article-0"]').click();
    assert.equal(window.scrollY, 0);
  } finally { app.dom.window.close(); }
});

test('scrolling records a chapter and independent language positions; reaching the end needs confirmation', async () => {
  const app = await setup({ body: '## 第一节\n\n正文。\n\n## 第二节\n\n更多正文。' });
  try {
    const { document, window, requests } = app;
    const mockLayout = () => {
      document.querySelector('#article').getBoundingClientRect = () => ({ top: 80 - window.scrollY, height: 2000 });
      [...document.querySelectorAll('#article h2')].forEach((h, i) => { h.getBoundingClientRect = () => ({ top: 100 + i * 500 - window.scrollY }); });
    };
    mockLayout(); window.scrollY = 700;
    window.dispatchEvent(new window.Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 400)); await flush();
    assert.equal(document.querySelector('#reading-status').value, 'reading');
    assert.match(document.querySelector('.article-chapter').textContent, /第二节/);
    const first = JSON.parse(requests.filter(r => r.options.method === 'PATCH').at(-1).options.body).reading;
    assert.equal(first.positions.translated.scrollY, 700);
    document.querySelector('[data-mode="original"]').click();
    assert.equal(window.scrollY, 0);
    mockLayout(); window.scrollY = 1400;
    document.querySelector('[data-mode="translated"]').click(); await flush();
    assert.equal(window.scrollY, 700);
    document.querySelector('[data-mode="original"]').click();
    assert.equal(window.scrollY, 1400);
    assert.equal(document.querySelector('#reading-status').value, 'reading');
    assert.equal(document.querySelector('#reading-progress').textContent, '99%');
    const last = JSON.parse(requests.filter(r => r.options.method === 'PATCH').at(-1).options.body).reading;
    assert.equal(last.positions.original.scrollY, 1400);
    assert.equal(last.positions.translated.scrollY, 700);
  } finally { app.dom.window.close(); }
});

test('finished state survives background refresh and reading resumes after a local save failure', async () => {
  const app = await setup({ reading: readingAt(), imageTranslation: pendingImages, failReading: true });
  try {
    app.document.querySelector('#finish-reading').click(); await flush();
    assert.match(app.document.querySelector('#toast').textContent, /暂存到此浏览器/);
    await app.pollImages(finishedImages);
    assert.equal(app.document.querySelector('#reading-status').value, 'finished');
    assert.equal(app.document.querySelector('.article-reading').textContent, '已读完');
    const cached = app.window.localStorage.getItem('shiye.reading.article-0');
    const reopened = await setup({ settings: { 'reading.article-0': cached } });
    try { assert.equal(reopened.document.querySelector('#reading-status').value, 'finished'); }
    finally { reopened.dom.window.close(); }
  } finally { app.dom.window.close(); }
});

test('a reset saved locally during a service failure overrides older server progress after reopening', async () => {
  const previous = readingAt(); previous.lastReadAt = '2026-01-01T00:00:00.000Z';
  const app = await setup({ reading: previous, failReading: true });
  try {
    const status = app.document.querySelector('#reading-status');
    status.value = 'unread'; status.dispatchEvent(new app.window.Event('change')); await flush();
    const cached = app.window.localStorage.getItem('shiye.reading.article-0');
    const reopened = await setup({ reading: previous, settings: { 'reading.article-0': cached } });
    try {
      assert.equal(reopened.document.querySelector('#reading-status').value, 'unread');
      assert.equal(reopened.window.scrollY, 0);
    } finally { reopened.dom.window.close(); }
  } finally { app.dom.window.close(); }
});

test('Substack image links split across paragraphs render without brackets or exposed original URLs', async () => {
  const base = 'https://substackcdn.com/image/fetch/$s_!JWUy!,';
  const asset = 'https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc875a11c-dd46-48ad-b6ab-acef3b576d0e_1277x1000.png';
  const thumbnail = `${base}w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/${asset}`;
  const fullSize = `${base}f_auto,q_auto:good,fl_progressive:steep/${asset}`;
  const broken = `[\n\n![](${thumbnail})\n\n](${fullSize})`;
  const app = await setup({ body: `图片前的正文。\n\n${broken}\n\n该模型呈现的是宏观全景。\n\n\`\`\`markdown\n${broken}\n\`\`\`` });
  try {
    for (const mode of ['translated', 'original', 'parallel']) {
      app.document.querySelector(`[data-mode="${mode}"]`).click();
      const article = app.document.querySelector('#article');
      assert.equal(article.querySelectorAll('img').length, mode === 'parallel' ? 2 : 1, article.innerHTML);
      const image = article.querySelector('img');
      assert.equal(image.src, thumbnail);
      assert.equal(image.parentElement.href, fullSize);
      assert.equal(image.parentElement.target, '_blank');
      for (const paragraph of article.querySelectorAll('p')) assert.ok(!/[\[\]]|https:\/\//.test(paragraph.textContent), paragraph.textContent);
      assert.equal(article.querySelector('pre code').textContent.trim(), broken);
      assert.match(article.textContent, /图片前的正文/);
      assert.match(article.textContent, /该模型呈现的是宏观全景/);
    }
  } finally { app.dom.window.close(); }
});

test('split numeric note brackets rejoin in every reading mode while code and other brackets stay literal', async () => {
  const broken = '\\[\n\n1\\] 注释正文与 **强调**、[来源](https://example.com/note)。';
  const code = '\\[\n\n2\\] 代码中的内容';
  const body = [
    '**注释**', broken, '注释的第二段。', '\\[12\\] 正常注释。',
    '\\[', '普通括号内容', '\\[', '3\\]no-space',
    `\`\`\`markdown\n${code}\n\`\`\``,
    '<pre><code>[\n\n4] 原始 HTML 代码</code></pre>',
    '\\[', '> 5\\] 引用内容',
  ].join('\n\n');
  const app = await setup({ body });
  try {
    for (const mode of ['translated', 'original', 'parallel']) {
      app.document.querySelector(`[data-mode="${mode}"]`).click();
      const article = app.document.querySelector('#article');
      const copies = mode === 'parallel' ? 2 : 1;
      const notes = [...article.querySelectorAll('p')].filter(p => p.textContent.startsWith('[1]'));
      assert.equal(notes.length, copies);
      for (const note of notes) {
        assert.equal(note.querySelector('strong').textContent, '强调');
        assert.equal(note.querySelector('a').href, 'https://example.com/note');
        assert.equal(note.nextElementSibling.textContent, '注释的第二段。');
      }
      assert.equal([...article.querySelectorAll('p')].filter(p => p.textContent === '[').length, 3 * copies);
      assert.equal(article.querySelector('pre code').textContent.trim(), code);
      assert.match(article.textContent, /\[12\] 正常注释/);
      assert.match(article.querySelector('blockquote').textContent, /5\] 引用内容/);
    }
    assert.equal(app.requests.filter(request => request.options.method === 'PATCH' && /translated|original/.test(request.options.body)).length, 0);
  } finally { app.dom.window.close(); }
});

test('citation markers rejoin the preceding paragraph as superscripts in every reading mode', async () => {
  const sourceURL = 'https://example.com/article';
  const citation = number => `\\[[${number}](${sourceURL}#f${number}n)\\]`;
  const body = [
    '前一段。', citation(1), citation(2), '后一段。',
    `行内引用${citation(17)} 后续文字。`,
    `<p>原生引用<sup>[<a href="${sourceURL}#f6n">6</a>]</sup>。</p>`,
    '\\[[3](https://other.example/article#f3n)\\]',
    `\\[[4](${sourceURL}#section4)\\]`, '\\[5\\]',
    '**注释**', '\\[1\\] 注释正文。',
    `\`\`\`markdown\n${citation(7)}\n\`\`\``,
    `<pre><code>[<a href="${sourceURL}#f8n">8</a>]</code></pre>`,
    '## 新章节', citation(9),
  ].join('\n\n');
  const app = await setup({ sourceURL, body });
  try {
    for (const mode of ['translated', 'original', 'parallel']) {
      app.document.querySelector(`[data-mode="${mode}"]`).click();
      const article = app.document.querySelector('#article');
      const copies = mode === 'parallel' ? 2 : 1;
      const paragraphs = [...article.querySelectorAll('p')];
      const joined = paragraphs.filter(p => p.textContent === '前一段。[1][2]');
      assert.equal(joined.length, copies);
      for (const paragraph of joined) {
        assert.equal(paragraph.querySelectorAll('sup.article-note-ref').length, 2);
        assert.equal(paragraph.nextElementSibling.textContent, '后一段。');
      }
      assert.equal(article.querySelectorAll('sup.article-note-ref').length, 5 * copies);
      assert.equal(article.querySelectorAll('sup sup').length, 0);
      assert.equal(article.querySelector(`sup a[href="${sourceURL}#f1n"]`).target, '_blank');
      assert.ok(paragraphs.some(p => p.textContent === '行内引用[17] 后续文字。'));
      assert.ok(paragraphs.some(p => p.textContent === '[3]' && !p.querySelector('sup')));
      assert.ok(paragraphs.some(p => p.textContent === '[4]' && !p.querySelector('sup')));
      assert.ok(paragraphs.some(p => p.textContent === '[5]' && !p.querySelector('sup')));
      assert.ok(paragraphs.some(p => p.textContent === '[1] 注释正文。' && !p.querySelector('sup')));
      assert.equal(article.querySelector('pre code').textContent.trim(), citation(7));
      assert.equal(article.querySelectorAll('pre sup').length, 0);
      assert.equal(article.querySelector('h2').nextElementSibling.textContent, '[9]');
    }
  } finally { app.dom.window.close(); }
});

test('finishing a translation still shows its translation when that article remains selected', async () => {
  const app = await setup({ backgroundJob: true });
  try {
    app.document.querySelector('[data-mode="original"]').click();
    app.document.querySelector('#import-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await app.pollJob('done');
    assert.equal(app.document.querySelector('#article h1').textContent, '第一篇');
    assert.equal(app.document.querySelector('[data-mode="translated"]').classList.contains('active'), true);
  } finally { app.dom.window.close(); }
});

test('reading starts without an import panel and the unified field submits pasted content', async () => {
  const app = await setup();
  try {
    const { window, document, requests } = app;
    assert.equal(document.querySelector('#import-section').hidden, true);
    assert.equal(document.querySelector('#article h1').textContent, '第一篇');
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    assert.equal(document.querySelector('#import-section').hidden, false);
    assert.equal(document.activeElement.id, 'article-input');
    const content = '# A new article\n\nThis article is long enough to be imported without a separate title field.';
    document.querySelector('#article-input').value = content;
    document.querySelector('#import-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const request = requests.find(r => r.url === '/api/import');
    assert.equal(JSON.parse(request.options.body).content, content);
    assert.equal(document.querySelector('#import-section').hidden, true);
  } finally { app.dom.window.close(); }
});

test('a browser extension handoff tracks the queued job and cleans the launch URL', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const app = await setup({ search: `?job=${id}` });
  try {
    const { window, document, requests } = app;
    assert.equal(requests.filter(request => request.url === `/api/jobs/${id}`).length, 1);
    assert.equal(window.location.search, '');
    assert.equal(document.querySelector('#job-status').hidden, true);
    assert.equal(document.querySelector('#article h1').textContent, '第一篇');
    assert.equal(window.localStorage.getItem('shiye.selected'), 'article-0');
  } finally { app.dom.window.close(); }
});

test('a pending extension handoff prefills the URL but waits for confirmation', async () => {
  const url = 'https://example.com/long?article=1';
  const app = await setup({ search: `?pending=${encodeURIComponent(url)}` });
  try {
    const { window, document, requests } = app;
    assert.equal(document.querySelector('#import-section').hidden, false);
    assert.equal(document.querySelector('#article-input').value, url);
    assert.equal(document.activeElement.id, 'article-input');
    assert.equal(requests.some(request => request.url === '/api/import'), false);
    assert.equal(window.location.search, '');
  } finally { app.dom.window.close(); }
});

test('the target language follows the browser, is remembered and sent; failed fetches offer open-and-paste', async () => {
  const lastJob = JSON.stringify({ status: 'error', message: '正文获取失败', fetchFailed: true, sourceURL: 'https://example.com/paywalled' });
  const app = await setup({ settings: { lastJob } });
  try {
    const { window, document, requests } = app;
    const picker = document.querySelector('#target-language');
    assert.equal(window.navigator.language, 'en-US'); assert.equal(picker.value, 'en');
    assert([...picker.options].some(option => option.value === 'zh-CN' && option.textContent === '简体中文'));
    assert.equal(document.querySelector('#job-actions').hidden, false);
    assert.equal(document.querySelector('#job-open-source').href, 'https://example.com/paywalled');
    picker.value = 'ja'; picker.dispatchEvent(new window.Event('change'));
    assert.equal(window.localStorage.getItem('shiye.targetLanguage'), 'ja');
    document.querySelector('#article-input').value = 'https://example.com/article';
    document.querySelector('#import-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(JSON.parse(requests.find(r => r.url === '/api/import').options.body).targetLanguage, 'ja');
    assert.equal(document.querySelector('#job-actions').hidden, true);
  } finally { app.dom.window.close(); }
});

test('the outline is an edge drawer without a toolbar button', async () => {
  const app = await setup({ body: '## 第一节\n\n正文。\n\n## 第二节\n\n正文。' });
  try {
    const { document, window } = app;
    const edge = document.querySelector('#outline-edge');
    assert.equal(document.querySelector('#outline-toggle'), null);
    assert.equal(edge.getAttribute('aria-controls'), 'outline-panel');
    assert.equal(document.body.classList.contains('has-article'), true);
    const links = [...document.querySelectorAll('#outline a')];
    assert.deepEqual(links.map(link => link.textContent), ['第一节', '第二节']);

    edge.click();
    assert.equal(document.body.classList.contains('outline-open'), true);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.body.classList.contains('outline-open'), false);

    edge.focus();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.activeElement.id, 'article');

    links[0].click();
    await flush();
    assert.equal(document.activeElement.id, 'article');
    assert.equal(document.body.classList.contains('outline-open'), false);
  } finally { app.dom.window.close(); }
});

test('Chinese underscore emphasis renders in every reading mode without changing literal syntax', async () => {
  const body = [
    '它__确实存在__，也_值得注意_。这是**正常加粗**与 __普通强调__。',
    '它__包含 `a__b` 和 [中文链接](https://example.com/a__b)__。',
    'snake_case foo__bar__baz 未配对__中文 \\_转义中文\\_ \\_\\_字面中文\\_\\_',
    '`它__确实存在__`',
    '```text\n它__确实存在__\n```',
    '<code>它__确实存在__</code>',
  ].join('\n\n');
  const app = await setup({ body });
  try {
    for (const mode of ['translated', 'original', 'parallel']) {
      app.document.querySelector(`[data-mode="${mode}"]`).click();
      const copies = mode === 'parallel' ? 2 : 1;
      assert.equal(app.document.querySelectorAll('#article strong').length, 4 * copies, app.document.querySelector('#article').innerHTML);
      assert.equal(app.document.querySelectorAll('#article em').length, copies);
      assert.equal(app.document.querySelector('#article strong').textContent, '确实存在');
      assert.match(app.document.querySelector('#article').textContent, /snake_case foo__bar__baz 未配对__中文 _转义中文_ __字面中文__/);
      assert.equal(app.document.querySelector('#article a[href="https://example.com/a__b"]').textContent, '中文链接');
      assert.equal(app.document.querySelector('#article strong code').textContent, 'a__b');
      const literalCode = [...app.document.querySelectorAll('#article code')].filter(node => node.textContent.trim() === '它__确实存在__');
      assert.equal(literalCode.length, 3 * copies);
      assert.ok(literalCode.every(node => !node.querySelector('strong')));
    }
  } finally { app.dom.window.close(); }
});

test('shelf actions operate on their own article without changing the current reading', async () => {
  const app = await setup();
  try {
    const { document, downloads, blobs } = app;
    document.querySelector('[aria-label="收藏《第二篇》"]').click(); await flush();
    assert.equal(document.querySelector('#article h1').textContent, '第一篇');
    assert.equal(document.querySelector('[aria-label="取消收藏《第二篇》"]').getAttribute('aria-pressed'), 'true');
    document.querySelector('[aria-label="下载《第二篇》的 Markdown"]').click();
    assert.equal(downloads[0], '第二篇-简体中文.md');
    const content = await blobs[0].text();
    assert.match(content, /# 第二篇\n\n完整的中文正文。/);
    assert.match(content, /\n\n---\n\n原文：https:\/\/example.com\/1\n$/);
    assert.equal(document.querySelector('#article h1').textContent, '第一篇');
  } finally { app.dom.window.close(); }
});

test('article titles link to the source in translated, original and parallel modes', async () => {
  const app = await setup({ heading: '**[第一篇](https://other.example/)**' });
  try {
    const { document } = app;
    for (const mode of ['translated', 'original', 'parallel']) {
      document.querySelector(`[data-mode="${mode}"]`).click();
      const headings = [...document.querySelectorAll('#article h1')];
      assert.equal(headings.length, mode === 'parallel' ? 2 : 1);
      for (const heading of headings) {
        const link = heading.querySelector('a.article-source-link');
        assert.equal(link.href, 'https://example.com/0');
        assert.equal(link.target, '_blank');
        assert.match(link.rel, /noopener/); assert.match(link.rel, /noreferrer/);
        assert.equal(heading.querySelectorAll('a').length, 1);
      }
    }
  } finally { app.dom.window.close(); }
});

test('pasted articles and unsafe source URLs do not turn titles into links', async () => {
  for (const sourceURL of ['', 'javascript:alert(1)', 'https://user:password@example.com']) {
    const app = await setup({ sourceURL });
    try {
      assert.equal(app.document.querySelector('#article h1').textContent, '第一篇');
      assert.equal(app.document.querySelector('#article h1 a.article-source-link'), null);
    } finally { app.dom.window.close(); }
  }
});

const imageSource = 'https://example.com/chart.png';
const imageTarget = '/media/11111111-1111-4111-8111-111111111111/abcdef123456abcdef123456/translated.png';
const pendingImages = { status: 'running', items: [{ source: imageSource, status: 'running' }] };
const finishedImages = { status: 'done', items: [{ source: imageSource, status: 'done', url: imageTarget }] };

test('image progress shows active stages, queued work and elapsed time while preserving reading nodes', async () => {
  const state = { status: 'running', startedAt: new Date(Date.now() - 65_000).toISOString(), items: [
    { source: imageSource, status: 'running', stage: 'recognizing' },
    { source: 'https://example.com/second.png', status: 'running', stage: 'rendering' },
    { source: 'https://example.com/third.png', status: 'queued' },
  ] };
  const app = await setup({ body: `![图](${imageSource})\n\n继续阅读。`, imageTranslation: state });
  try {
    const heading = app.document.querySelector('#article h1');
    const notice = app.document.querySelector('#article-notice');
    assert.match(notice.textContent, /2 张处理中，1 张排队/);
    assert.match(notice.textContent, /识别与排版 \/ 绘制译图.*已用 1 分/);
    await app.pollImages({ ...state, items: [{ source: imageSource, status: 'running', stage: 'replaying' }] });
    assert.match(notice.textContent, /重放已有结果/);
    assert.equal(app.document.querySelector('#article h1'), heading);
    await app.pollImages({ status: 'error', items: [{ source: imageSource, status: 'error', errorCode: 'IMAGE_VALIDATION' }] });
    assert.match(notice.textContent, /已保存识别结果.*本地重放/);
  } finally { app.dom.window.close(); }
});

test('images update asynchronously without rebuilding text or blocking a new import', async () => {
  const app = await setup({ body: `![图表](${imageSource})\n\n继续阅读这段正文。`, imageTranslation: pendingImages });
  try {
    const heading = app.document.querySelector('#article h1');
    const paragraph = [...app.document.querySelectorAll('#article p')].at(-1);
    assert.match(app.document.querySelector('#article-notice').textContent, /正文已译好.*后台解读/);
    assert.equal(app.document.querySelector('#import-button').disabled, false);
    await app.pollImages(finishedImages);
    assert.equal(app.document.querySelector('#article h1'), heading);
    assert.equal([...app.document.querySelectorAll('#article p')].at(-1), paragraph);
    assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageTarget);
    assert.equal(app.document.querySelector('#article img').parentElement.getAttribute('href'), imageTarget);
    assert.equal(app.document.querySelector('#article-notice').hidden, true);
    app.document.querySelector('[data-mode="original"]').click();
    assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageSource);
    app.document.querySelector('[data-mode="parallel"]').click();
    assert.deepEqual([...app.document.querySelectorAll('#article img')].map(image => image.getAttribute('src')), [imageTarget, imageSource]);
    assert.equal(app.document.querySelector('#article .parallel-side img').parentElement.getAttribute('href'), imageTarget);
    app.document.querySelector('[data-mode="translated"]').click();
    app.document.querySelector('[aria-label="下载《第一篇》的 Markdown"]').click();
    assert.match(await app.blobs[0].text(), /http:\/\/127.0.0.1:4317\/media\//);
  } finally { app.dom.window.close(); }
});

test('background images preserve another selected article and the original reading mode', async () => {
  const app = await setup({ body: `![图表](${imageSource})`, imageTranslation: pendingImages });
  try {
    app.document.querySelector('[data-article-id="article-1"]').click();
    app.document.querySelector('[data-mode="original"]').click();
    const heading = app.document.querySelector('#article h1');
    await app.pollImages(finishedImages);
    assert.equal(app.document.querySelector('#article h1'), heading);
    assert.equal(app.document.querySelector('[data-mode="original"]').classList.contains('active'), true);
    app.document.querySelector('[data-article-id="article-0"]').click();
    assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageSource);
    app.document.querySelector('[data-mode="translated"]').click();
    assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageTarget);
  } finally { app.dom.window.close(); }
});

test('image failures keep the original and offer an independent retry', async () => {
  const app = await setup({ body: `![图表](${imageSource})`, imageTranslation: pendingImages });
  try {
    await app.pollImages({ status: 'error', items: [{ source: imageSource, status: 'error' }] });
    assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageSource);
    assert.match(app.document.querySelector('#article-notice').textContent, /已保留原图/);
    app.document.querySelector('#article-notice button').click(); await flush();
    assert.ok(app.requests.some(request => request.url === '/api/articles/article-0/images' && request.options.method === 'POST'));
    assert.ok(!app.requests.some(request => request.url.endsWith('/translate')));
    assert.match(app.document.querySelector('#article-notice').textContent, /后台解读中/);
    assert.equal(app.document.querySelector('#import-button').disabled, false);
  } finally { app.dom.window.close(); }
});

test('text-only image insights keep original images and reading nodes, stay out of the reader and export with translations only', async () => {
  const insight = { kind: 'flowchart', summary: '<script>不应执行</script>', translatedText: '输入 → 阅读', originalText: 'Input → Read', uncertainties: ['小字无法确认'],
    diagram: { nodes: [{ id: 'a', label: '输入' }, { id: 'b', label: '阅读' }], edges: [{ from: 'a', to: 'b', label: '完成' }] } };
  const app = await setup({ body: `![流程](${imageSource})\n\n继续阅读。`, imageTranslation: pendingImages });
  try {
    const heading = app.document.querySelector('#article h1');
    const paragraph = [...app.document.querySelectorAll('#article > p')].at(-1);
    await app.pollImages({ status: 'done', items: [{ status: 'done', source: imageSource, insight }] });
    assert.equal(app.document.querySelector('#article h1'), heading);
    assert.equal([...app.document.querySelectorAll('#article > p')].at(-1), paragraph);
    assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageSource);
    assert.equal(app.document.querySelector('#article img').closest('a').getAttribute('href'), imageSource);
    assert.equal(app.document.querySelector('#article-notice').hidden, false);
    assert.equal(app.document.querySelector('.image-insight'), null);
    assert.equal(app.document.querySelector('#article script'), null);
    app.document.querySelector('[aria-label="下载《第一篇》的 Markdown"]').click();
    assert.match(await app.blobs.at(-1).text(), /输入 → 阅读/);
    app.document.querySelector('[data-mode="original"]').click();
    assert.equal(app.document.querySelector('.image-insight'), null);
    app.document.querySelector('[aria-label="下载《第一篇》的 Markdown"]').click();
    assert.doesNotMatch(await app.blobs.at(-1).text(), /图片解读/);
    app.document.querySelector('[data-mode="parallel"]').click();
    assert.equal(app.document.querySelector('.image-insight'), null);
    assert.deepEqual([...app.document.querySelectorAll('#article img')].map(image => image.getAttribute('src')), [imageSource, imageSource]);
  } finally { app.dom.window.close(); }
});

test('invalid stored insight leaves the article readable without inserting markup', async () => {
  const app = await setup({ body: `![图表](${imageSource})`, imageTranslation: { status: 'done', items: [{ source: imageSource, status: 'done', insight: { kind: 'flowchart', summary: 'x', diagram: { nodes: [], edges: [] } } }] } });
  try {
    assert.equal(app.document.querySelector('.image-insight'), null);
    assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageSource);
  } finally { app.dom.window.close(); }
});

test('recognized photos and complex images retained after redraw do not show repeated redraw prompts', async () => {
  for (const item of [
    { source: imageSource, status: 'done', insight: { kind: 'photo', summary: '照片，保留原图。' } },
    { source: imageSource, status: 'done', redrawAttempted: true, insight: { kind: 'other', summary: '无法可靠重绘，保留原图。' } },
  ]) {
    const app = await setup({ body: `![图](${imageSource})`, imageTranslation: { status: 'done', items: [item] } });
    try {
      assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageSource);
      assert.equal(app.document.querySelector('.image-insight'), null);
      assert.equal(app.document.querySelector('#article-notice').hidden, true);
    } finally { app.dom.window.close(); }
  }
});

test('faithful SVG replaces the image without an explanation panel and toggles original without losing text', async () => {
  const target = imageTarget.replace('.png', '.svg');
  const insight = { kind: 'flowchart', summary: '按原图配色重绘', scene: { width: 600, height: 300, background: '#faf9f6', elements: [{ type: 'text', x: 30, y: 60, text: '中文' }] } };
  const app = await setup({ body: `![图](${imageSource})\n\n继续阅读`, imageTranslation: pendingImages });
  try {
    const heading = app.document.querySelector('#article h1');
    const completed = { source: imageSource, url: target, status: 'done', insight };
    await app.pollImages({ status: 'running', items: [completed] });
    const img = app.document.querySelector('#article img');
    assert.equal(img.getAttribute('src'), target); assert.equal(app.document.querySelector('#article h1'), heading);
    assert.equal(app.document.querySelector('.image-insight'), null);
    assert.doesNotMatch(app.document.querySelector('#article').textContent, /查看图片解读/);
    assert.equal(app.document.querySelector('.image-controls').textContent, '查看原图');
    const toggle = app.document.querySelector('.image-controls button'); toggle.click();
    assert.equal(img.getAttribute('src'), imageSource); assert.equal(toggle.textContent, '查看译图');
    await app.pollImages({ status: 'done', items: [completed] });
    assert.equal(img.getAttribute('src'), imageSource);
    assert.equal(app.document.querySelector('.image-insight'), null);
    toggle.click(); assert.equal(img.getAttribute('src'), target);
    img.dispatchEvent(new app.window.Event('error'));
    assert.equal(img.getAttribute('src'), imageSource);
    assert.match(app.document.querySelector('.image-controls').textContent, /加载失败/);
    assert.equal(app.document.querySelector('.image-controls span').hidden, false);
    toggle.click();
    assert.equal(img.getAttribute('src'), target);
    assert.equal(app.document.querySelector('.image-controls span').hidden, true);
    app.document.querySelector('[data-mode="original"]').click();
    assert.equal(app.document.querySelector('#article img').getAttribute('src'), imageSource);
    assert.equal(app.document.querySelector('.image-controls'), null);
    app.document.querySelector('[data-mode="parallel"]').click();
    assert.deepEqual([...app.document.querySelectorAll('#article img')].map(img => img.getAttribute('src')), [target, imageSource]);
    assert.equal(app.document.querySelector('.image-insight'), null);
  } finally { app.dom.window.close(); }
});

test('non-Mac shortcut labels use Ctrl instead of Command', async () => {
  const app = await setup({ platform: 'Win32' });
  try {
    assert.equal(app.document.querySelector('.new-article kbd').textContent, 'Ctrl+K');
    assert.match(app.document.querySelector('#import-button').getAttribute('title'), /Ctrl\+Enter/);
    assert.match(app.document.querySelector('#import-toggle').getAttribute('title'), /Ctrl\+K/);
  } finally { app.dom.window.close(); }
});

test('fullscreen button enters fullscreen with only the article and exits on Escape', async () => {
  const app = await setup();
  try {
    const { document, window } = app;
    let element = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });
    document.documentElement.requestFullscreen = async function () {
      element = document.documentElement;
      document.dispatchEvent(new window.Event('fullscreenchange'));
    };
    document.exitFullscreen = async function () {
      element = null;
      document.dispatchEvent(new window.Event('fullscreenchange'));
    };
    const toggle = document.querySelector('#focus-toggle');
    const exit = document.querySelector('#focus-exit');
    toggle.click(); await flush();
    assert.equal(element, document.documentElement);
    assert.equal(document.body.classList.contains('focus-mode'), true);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.getAttribute('aria-label'), '退出全屏');
    assert.equal(exit.hidden, false);
    assert.equal(document.activeElement, document.querySelector('#article'));

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    assert.equal(element, null);
    assert.equal(document.body.classList.contains('focus-mode'), false);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.getAttribute('aria-label'), '全屏阅读');
    assert.equal(exit.hidden, true);

    toggle.click(); await flush();
    assert.equal(element, document.documentElement);
    exit.click(); await flush();
    assert.equal(element, null);
    assert.equal(document.body.classList.contains('focus-mode'), false);
  } finally { app.dom.window.close(); }
});

test('fullscreen falls back to the focused layout when the browser cannot enter fullscreen', async () => {
  const app = await setup();
  try {
    const { document, window } = app;
    assert.equal(document.documentElement.requestFullscreen, undefined);
    const toggle = document.querySelector('#focus-toggle');
    toggle.click(); await flush();
    assert.equal(document.body.classList.contains('focus-mode'), true);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('#focus-exit').hidden, false);
    assert.match(document.querySelector('#toast').textContent, /无法隐藏浏览器界面/);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    assert.equal(document.body.classList.contains('focus-mode'), false);
  } finally { app.dom.window.close(); }
});
