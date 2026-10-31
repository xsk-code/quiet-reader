import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractArticle, getArticleTitle, isPublicAddress, validateURL, splitMarkdown, fetchArticleHTML, pageStatusError } from '../lib/article.mjs';
import { languageFromLocale } from '../lib/languages.mjs';
import { cleanAgentOutput, translateArticle, runAgent } from '../lib/translate.mjs';
import { ArticleStore, extractTranslatedTitle } from '../lib/store.mjs';
import { parseImportInput } from '../lib/import-input.mjs';

const skipWindowsAgent = process.platform === 'win32' ? 'Windows local CLI agents are unsupported' : false;

test('unified import recognizes article links and surrounding whitespace', () => {
  assert.deepEqual(parseImportInput('  https://example.com/article?lang=en\n'), { url: 'https://example.com/article?lang=en' });
  assert.deepEqual(parseImportInput('https://example.com'), { url: 'https://example.com/' });
});

test('unified import recognizes a Markdown link and links without a scheme', () => {
  assert.deepEqual(parseImportInput('[Good article](https://example.com/read)'), { url: 'https://example.com/read' });
  assert.deepEqual(parseImportInput('example.com/read'), { url: 'https://example.com/read' });
});

test('unified import keeps Markdown and plain-text articles intact', () => {
  const markdown = '# A thoughtful article\n\nA sufficiently long paragraph that should be translated in full.';
  assert.deepEqual(parseImportInput(markdown), { title: 'A thoughtful article', markdown });
  const plain = 'An article with no Markdown heading\n\nIts body remains part of the imported text.';
  assert.deepEqual(parseImportInput(plain), { title: 'An article with no Markdown heading', markdown: plain });
});

test('unified import rejects empty input, unsafe links and oversized text', () => {
  for (const value of ['', null, 'short', 'ftp://example.com/file', 'https://user:password@example.com', 'x'.repeat(120001)]) assert.throws(() => parseImportInput(value));
});

test('only accepts public addresses and ordinary web URLs', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', '2002:7f00:1::', 'fc00::1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  assert.throws(() => validateURL('file:///etc/passwd'));
  assert.throws(() => validateURL('https://user:password@example.com'));
  assert.throws(() => validateURL('http://example.com:9222'));
  assert.equal(validateURL('https://example.com/article').hostname, 'example.com');
});

test('prefers working IPv4 even when DNS returns IPv6 first', async () => {
  const attempts = [];
  const page = await fetchArticleHTML('https://example.com/article', 0, {
    resolveAddresses: async () => [{ address: '2606:4700:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }],
    requestPage: async (url, address) => {
      attempts.push(address.family);
      if (address.family === 6) throw Object.assign(new Error('IPv6 is unreachable'), { retryable: true });
      return { html: '<article>Actual article</article>', url: url.href };
    },
  });
  assert.deepEqual(attempts, [4]); assert.match(page.html, /Actual article/);
});

test('tries another validated address after a connection failure', async () => {
  const attempts = [];
  await fetchArticleHTML('https://example.com/article', 0, {
    resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }, { address: '8.8.8.8', family: 4 }],
    requestPage: async (url, address) => {
      attempts.push(address.address);
      if (address.address === '1.1.1.1') throw Object.assign(new Error('Connection timed out'), { retryable: true });
      return { html: '<article>Recovered article</article>', url: url.href };
    },
  });
  assert.deepEqual(attempts, ['1.1.1.1', '8.8.8.8']);
});

test('fallback never requests private addresses, including after a redirect', async () => {
  let attempts = 0;
  await assert.rejects(() => fetchArticleHTML('https://example.com/article', 0, {
    resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
    requestPage: async () => { attempts++; },
  }), /内网地址/);
  assert.equal(attempts, 0);
  await assert.rejects(() => fetchArticleHTML('https://example.com/article', 0, {
    resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
    requestPage: async () => { attempts++; return { redirect: 'http://127.0.0.1/private' }; },
  }), /内网地址/);
  assert.equal(attempts, 1);
});

test('does not retry website errors as network failures', async () => {
  let attempts = 0;
  await assert.rejects(() => fetchArticleHTML('https://example.com/article', 0, {
    resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }, { address: '8.8.8.8', family: 4 }],
    requestPage: async () => { attempts++; throw new Error('HTTP 403'); },
  }), /HTTP 403/);
  assert.equal(attempts, 1);
});

const xPostURL = 'https://x.com/writer/status/123';
const xCardHTML = (destination = 'https://t.co/article') => `<html><head><meta property="og:description" content="Read my article ${destination}"></head><body><article><p>Post introducing an external article.</p><a href="/writer/status/123">Post timestamp</a><a href="${destination}"><img src="https://pbs.twimg.com/card_img/123/cover">Full article title</a><p>Truncated preview...</p></article></body></html>`;

test('X article cards fetch the full external article through validated redirects', async () => {
  const requested = [];
  const page = await fetchArticleHTML(xPostURL, 0, {
    resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
    requestPage: async url => {
      requested.push(url.href);
      if (url.hostname === 'x.com') return { html: xCardHTML(), url: url.href };
      if (url.hostname === 't.co') return { redirect: 'https://writer.example/full-article' };
      return { html: '<article>Full article including its final section.</article>', url: url.href };
    },
  });
  assert.deepEqual(requested, [xPostURL, 'https://t.co/article', 'https://writer.example/full-article']);
  assert.equal(page.url, 'https://writer.example/full-article');
  assert.match(page.html, /final section/);
});

test('X article cards use matching expanded URL entities without executing hydration scripts', async () => {
  const data = { url_entities: [
    { url: 'https://t.co/profile', expanded_url: 'https://profile.example/' },
    { url: 'https://t.co/article', expanded_url: 'https://writer.example/full-article' },
  ] };
  for (const script of [JSON.stringify(data), `window.test = {body:${JSON.stringify(JSON.stringify(data))}}; throw new Error('Do not execute');`]) {
    const requested = [];
    await fetchArticleHTML(xPostURL, 0, {
      resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
      requestPage: async url => {
        requested.push(url.href);
        return { html: url.hostname === 'x.com' ? xCardHTML() + `<script>${script}</script>` : '<article>Full article</article>', url: url.href };
      },
    });
    assert.deepEqual(requested, [xPostURL, 'https://writer.example/full-article']);
  }
});

test('ordinary links, reply cards, native X articles and ambiguous cards do not replace the post', async () => {
  const card = xCardHTML().match(/<article>[\s\S]*<\/article>/)[0];
  for (const [url, html] of [
    [xPostURL, card.replace(/<img[^>]+>/, '')],
    [xPostURL, card.replace('/writer/status/123', '/reply/status/456')],
    [xPostURL, xCardHTML() + '<div data-testid="twitterArticleRichTextView">Native article</div>'],
    [xPostURL, card.replace('</article>', '<a href="https://other.example/read" data-testid="card.wrapper">Other article</a></article>')],
    ['https://writer.example/post', xCardHTML()],
  ]) {
    let attempts = 0;
    const page = await fetchArticleHTML(url, 0, {
      resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
      requestPage: async url => { attempts++; return { html, url: url.href }; },
    });
    assert.equal(attempts, 1);
    assert.equal(page.html, html);
  }
});

test('X article cards reject private destinations and never silently save a failed preview', async () => {
  for (const destination of ['http://127.0.0.1/private', 'https://t.co/article']) {
    const requested = [];
    await assert.rejects(() => fetchArticleHTML(xPostURL, 0, {
      resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
      requestPage: async url => {
        requested.push(url.href);
        if (url.hostname === 'x.com') return { html: xCardHTML(destination), url: url.href };
        return { redirect: 'http://127.0.0.1/private' };
      },
    }), /外链文章.*内网地址/);
    assert.ok(requested.every(url => !url.includes('127.0.0.1')));
  }
  await assert.rejects(() => fetchArticleHTML(xPostURL, 0, {
    resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
    requestPage: async url => {
      if (url.hostname === 'x.com') return { html: xCardHTML(), url: url.href };
      throw new Error('HTTP 403');
    },
  }), /外链文章.*HTTP 403/);
});

test('Agent launch confirms a real subprocess, pipes the prompt and captures its response', { skip: skipWindowsAgent }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-agent-'));
  const previous = process.env.CODEX_BIN;
  try {
    const executable = path.join(dir, 'test-agent.mjs');
    await writeFile(executable, `#!${process.execPath}\nlet input='';for await(const chunk of process.stdin)input+=chunk;if(!input.includes('Translate this'))process.exit(2);process.stdout.write('# 真实子进程返回的测试译文');\n`, { mode: 0o755 });
    process.env.CODEX_BIN = executable;
    let started;
    const output = await runAgent('codex', 'Translate this', dir, { onStarted: event => { started = event; } });
    assert.equal(started.provider, 'codex'); assert.ok(started.pid > 0);
    assert.equal(output, '# 真实子进程返回的测试译文');
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('agy selects Gemini 3.8 Flash Low for text translation', { skip: skipWindowsAgent }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-agy-model-'));
  const previous = process.env.AGY_BIN;
  try {
    const executable = path.join(dir, 'test-agy.mjs');
    await writeFile(executable, `#!${process.execPath}\nconst args=process.argv.slice(2);const i=args.indexOf('--model');if(i<0||args[i+1]!=='gemini-3.8-flash-low')process.exit(42);if(args[args.indexOf('--print')+1]!=='Translate this')process.exit(43);if(args.includes('--effort')||args.includes('--agent'))process.exit(44);if(args[args.indexOf('--print-timeout')+1]!=='210s')process.exit(45);process.stdout.write('# 指定模型测试通过');\n`, { mode: 0o755 });
    process.env.AGY_BIN = executable;
    const output = await runAgent('agy', 'Translate this', dir);
    assert.equal(output, '# 指定模型测试通过');
  } finally {
    if (previous === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('extracts the article without menus and preserves absolute links, tables, images and fenced code', () => {
  const paragraph = 'Reading long articles can be comfortable when the content is separated from navigation and advertising. The article should retain its original structure and links. ';
  const html = `<html><head><title>A quiet page</title></head><body><nav>Menu Advertising Login</nav><article><h1>A quiet page</h1><p>${paragraph.repeat(4)}</p><h2>Structure</h2><p>${paragraph.repeat(3)}<a href="/more">Read more</a></p><img src="images/book.png" alt="Book"><pre><code>const answer = 42;</code></pre><table><thead><tr><th>Language</th><th>Text</th></tr></thead><tbody><tr><td>English</td><td>Read</td></tr></tbody></table><script>alert('bad')</script></article></body></html>`;
  const article = extractArticle(html, 'https://example.com/posts/article');
  assert.equal(article.title, 'A quiet page');
  assert.match(article.original, /## Structure/);
  assert.match(article.original, /https:\/\/example.com\/more/);
  assert.match(article.original, /https:\/\/example.com\/posts\/images\/book.png/);
  assert.match(article.original, /```\nconst answer = 42;/);
  assert.match(article.original, /\| Language/);
  assert.doesNotMatch(article.original, /Menu Advertising|alert\('bad'\)/);
  assert.throws(() => extractArticle('<html><body>Login</body></html>', 'https://example.com'));
});

test('image links containing block wrappers stay on one Markdown line', () => {
  const paragraph = 'This is a detailed article about personal development and learning, with an illustration that links to its original size. '.repeat(5);
  const html = `<html><head><title>Image article</title></head><body><article><h1>Image article</h1><p>${paragraph}</p><a href="/full.png"><div><picture><img src="/thumbnail.png" alt="Overview"></picture></div></a><p>${paragraph}</p></article></body></html>`;
  const article = extractArticle(html, 'https://example.com/article');
  assert.match(article.original, /\[!\[Overview\]\(https:\/\/example.com\/thumbnail.png\)\]\(https:\/\/example.com\/full.png\)/);
  assert.doesNotMatch(article.original, /\[\s*\n\s*\n!\[/);
});

test('legacy numeric note anchors keep their brackets together after extraction', () => {
  const paragraph = 'An article about doing great work and following your curiosity. '.repeat(12);
  const html = `<html><head><title>Notes</title></head><body><article><font size="2" face="verdana">${paragraph}<br><br><b>Notes</b><br><br>[<a name="f1n"><font color="#000000">1</font></a>] First note with <em>emphasis</em>.<br><br>[<a name="f2n"><font color="#000000">2</font></a>] Second note.</font></article></body></html>`;
  const article = extractArticle(html, 'https://example.com/article');
  assert.match(article.original, /\\\[1\\\] First note with _emphasis_\./);
  assert.match(article.original, /\\\[2\\\] Second note\./);
  assert.doesNotMatch(article.original, /\\\[\s*\n\s*\n\d/);
});

test('legacy inline citations stay attached to their paragraph and preserve superscript markup', () => {
  const paragraph = 'An article about doing great work and following your curiosity. '.repeat(12);
  const html = `<html><head><title>Citations</title></head><body><article><font size="2" face="verdana">${paragraph}<br><br>Follow your interests. <font color="#dddddd">[<a href="#f1n"><font color="#dddddd">1</font></a>]</font><br><br>Keep exploring <font color="#dddddd">[<a href="#f17n">17</a>]</font> and learning.<br><br>Next paragraph.<br><br><b>Notes</b><br><br>[<a name="f1n">1</a>] The first note.</font></article></body></html>`;
  const article = extractArticle(html, 'https://example.com/article');
  assert.match(article.original, /Follow your interests\. <sup>\[<a href="https:\/\/example.com\/article#f1n">1<\/a>\]<\/sup>\n\nKeep exploring/);
  assert.match(article.original, /Keep exploring <sup>\[<a href="https:\/\/example.com\/article#f17n">17<\/a>\]<\/sup> and learning\./);
  assert.match(article.original, /\\\[1\\\] The first note\./);
});

test('unrelated numeric font links and malformed URLs are not treated as citations', () => {
  const paragraph = 'An article about doing great work and following your curiosity. '.repeat(12);
  const html = `<article><h1>Links</h1><p>${paragraph}</p><p>Other page <font>[<a href="https://other.example/article#f1n">1</a>]</font> and section <font>[<a href="#section2">2</a>]</font>.</p><p><font>[<a href="http://[invalid">3</a>]</font></p></article>`;
  const article = extractArticle(html, 'https://example.com/article');
  assert.doesNotMatch(article.original, /<sup>/);
  assert.match(article.original, /https:\/\/other.example\/article#f1n/);
  assert.match(article.original, /https:\/\/example.com\/article#section2/);
  assert.match(article.original, /3/);
});

test('uses the real title from X article metadata instead of the generic profile title', () => {
  const paragraph = 'Reading long articles can be comfortable when the content is separated from navigation and advertising. The article should retain its original structure and links. ';
  const html = `<html><head><title>DAN KOE (@thedankoe) on X</title><meta property="og:title" content="DAN KOE (@thedankoe) on X"><meta name="description" content="How to fix your entire life in 1 day"></head><body><article><p>${paragraph.repeat(4)}</p></article></body></html>`;
  const article = extractArticle(html, 'https://x.com/thedankoe/status/2010751592346030461');
  assert.equal(article.title, 'How to fix your entire life in 1 day');
  assert.equal(getArticleTitle({ title: 'A page on X', excerpt: 'A title', sourceURL: 'https://example.com/article' }), 'A page on X');
});

test('splits between blocks, keeps fenced code intact and preserves all content', () => {
  const code = '```js\nconst a = 1;\n\nconst b = 2;\n```';
  const source = ['# Article', 'First paragraph.', code, 'Last paragraph.'].join('\n\n');
  const chunks = splitMarkdown(source, 40);
  assert.equal(chunks.join('\n\n'), source);
  assert.ok(chunks.some(chunk => chunk.includes(code)));
  assert.throws(() => splitMarkdown('x'.repeat(33_000)), /连续段落/);
});

test('cleans a Markdown wrapper without removing actual code blocks', () => {
  assert.equal(cleanAgentOutput('```markdown\n# 中文\n\n正文\n```'), '# 中文\n\n正文');
  assert.equal(cleanAgentOutput('```js\nconst a = 1\n```'), '```js\nconst a = 1\n```');
});

test('translated titles use the main heading, decode formatting and ignore code examples', () => {
  assert.equal(extractTranslatedTitle('```md\n# Not the title\n```\n\n# **中文** &amp; [文章](https://example.com)\n\n正文'), '中文 & 文章');
  assert.equal(extractTranslatedTitle('中文标题\n===\n\n正文'), '中文标题');
  assert.equal(extractTranslatedTitle('## 章节标题\n\n正文'), '');
  assert.equal(extractTranslatedTitle(null), '');
});

test('existing translated articles get Chinese shelf titles without replacing their original titles', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-title-'));
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    await writeFile(path.join(dir, 'articles.json'), JSON.stringify([{ id, title: 'Original article title', original: 'Original text', translated: '# 已有的中文译名\n\n中文正文', status: 'ready' }]));
    const store = new ArticleStore(dir); await store.init();
    assert.equal(store.get(id).translatedTitle, '已有的中文译名');
    assert.equal(store.get(id).title, 'Original article title');
    await store.update(id, { translated: '# 更新后的中文译名\n\n新译文' });
    assert.equal(store.get(id).translatedTitle, '更新后的中文译名');
    await store.update(id, { starred: true });
    assert.equal(store.get(id).translatedTitle, '更新后的中文译名');
    const saved = JSON.parse(await readFile(store.file, 'utf8'))[0];
    assert.equal(saved.translatedTitle, '更新后的中文译名');
    assert.match(await readFile(path.join(dir, 'articles', id, 'original.md'), 'utf8'), /# Original article title/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('existing X articles recover their real title from the saved excerpt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-x-title-'));
  try {
    const id = '22222222-2222-4222-8222-222222222222';
    const alreadyMigratedId = '33333333-3333-4333-8333-333333333333';
    await writeFile(path.join(dir, 'articles.json'), JSON.stringify([
      { id, title: 'DAN KOE (@thedankoe) on X', excerpt: 'How to fix your entire life in 1 day', sourceURL: 'https://x.com/thedankoe/status/2010751592346030461', original: '正文', translated: '# DAN KOE (@thedankoe) 在 X 上\n\n译文', status: 'ready' },
      { id: alreadyMigratedId, title: 'How to fix your entire life in 1 day', excerpt: 'How to fix your entire life in 1 day', sourceURL: 'https://x.com/thedankoe/status/2010751592346030461', original: '正文', translated: '# DAN KOE (@thedankoe) 在 X 上\n\n译文', status: 'ready' },
    ]));
    const store = new ArticleStore(dir); await store.init();
    assert.equal(store.get(id).title, 'How to fix your entire life in 1 day');
    assert.equal(store.get(id).translatedTitle, 'How to fix your entire life in 1 day');
    assert.match(store.get(id).translated, /^# How to fix your entire life in 1 day\n\n译文/);
    assert.match(await readFile(path.join(dir, 'articles', id, 'original.md'), 'utf8'), /# How to fix your entire life in 1 day\n\n正文/);
    assert.match(await readFile(path.join(dir, 'articles', id, 'translated.md'), 'utf8'), /# How to fix your entire life in 1 day\n\n译文/);
    assert.equal(store.get(alreadyMigratedId).translatedTitle, 'How to fix your entire life in 1 day');
    assert.match(store.get(alreadyMigratedId).translated, /^# How to fix your entire life in 1 day\n\n译文/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('article store persists concurrent changes and recovers interrupted translations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-store-'));
  try {
    const store = new ArticleStore(dir); await store.init();
    const a = await store.add({ title: 'A', original: 'One' });
    const b = await store.add({ title: 'B', original: 'Two' });
    await Promise.all([store.update(a.id, { starred: true }), store.update(b.id, { status: 'translating' })]);
    const saved = JSON.parse(await readFile(store.file, 'utf8'));
    assert.equal(saved.find(item => item.id === a.id).starred, true);
    assert.match(await readFile(path.join(dir, 'articles', a.id, 'original.md'), 'utf8'), /# A\n\nOne/);
    await store.update(a.id, { translated: '# 译文\n\n第一篇' });
    assert.match(await readFile(path.join(dir, 'articles', a.id, 'translated.md'), 'utf8'), /第一篇/);
    const reloaded = new ArticleStore(dir); await reloaded.init();
    assert.equal(reloaded.get(b.id).status, 'error'); assert.equal(reloaded.get(b.id).original, 'Two');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deleting and restoring an article persists across restarts and keeps its Markdown', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-delete-'));
  try {
    const store = new ArticleStore(dir); await store.init();
    const article = await store.add({ title: 'Original title', original: 'Original text' });
    await store.update(article.id, { translated: '# 中文标题\n\n完整译文', status: 'ready', starred: true });
    await store.remove(article.id);
    assert.equal(store.get(article.id), undefined);
    assert.deepEqual(store.list(), []);
    assert.match(await readFile(path.join(dir, 'articles', article.id, 'translated.md'), 'utf8'), /完整译文/);
    const reloaded = new ArticleStore(dir); await reloaded.init();
    assert.deepEqual(reloaded.list(), []);
    const restored = await reloaded.restore(article.id);
    assert.equal(restored.starred, true);
    assert.equal(restored.translatedTitle, '中文标题');
    assert.equal(restored.original, 'Original text');
    assert.equal(reloaded.list().length, 1);
    const saved = JSON.parse(await readFile(reloaded.file, 'utf8'))[0];
    assert.equal(saved.deletedAt, undefined);
    await assert.rejects(() => reloaded.restore(article.id), /可恢复/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an in-progress translation cannot be deleted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-delete-busy-'));
  try {
    const store = new ArticleStore(dir); await store.init();
    const article = await store.add({ title: 'Busy article', original: 'Original text' });
    await store.update(article.id, { status: 'translating' });
    await assert.rejects(() => store.remove(article.id), /正在翻译/);
    assert.equal(store.list().length, 1);
    await assert.rejects(() => store.remove('missing'), /文章不存在/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reading state migrates old articles and persists completion, positions and reset across restarts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-reading-'));
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    await writeFile(path.join(dir, 'articles.json'), JSON.stringify([{ id, title: 'Existing article', original: 'Original text', status: 'ready', translated: '# 译文' }]));
    const store = new ArticleStore(dir); await store.init();
    assert.equal(store.get(id).reading.status, 'unread');
    const positions = { translated: { scrollY: 700, progress: 40, heading: '第二节' }, original: { scrollY: 350, progress: 20, heading: 'Part two' } };
    await store.updateReading(id, { status: 'reading', positions, lastMode: 'translated' });
    await store.update(id, { starred: true, translated: '# 新译文' });
    assert.equal(store.get(id).reading.progress, 40);
    assert.deepEqual(store.get(id).reading.positions, positions);
    await store.updateReading(id, { status: 'finished', positions, lastMode: 'translated' });
    const finishedAt = store.get(id).reading.finishedAt;
    assert.ok(finishedAt);
    const restarted = new ArticleStore(dir); await restarted.init();
    assert.equal(restarted.get(id).reading.status, 'finished');
    assert.equal(restarted.get(id).reading.progress, 100);
    assert.deepEqual(restarted.get(id).reading.positions, positions);
    await restarted.remove(id); await restarted.restore(id);
    assert.equal(restarted.get(id).reading.finishedAt, finishedAt);
    await restarted.updateReading(id, { status: 'unread', positions, lastMode: 'translated' });
    assert.equal(restarted.get(id).reading.progress, 0);
    assert.deepEqual(restarted.get(id).reading.positions, {});
    assert.equal(restarted.get(id).reading.finishedAt, null);
    assert.equal((await restarted.add({ title: 'New', original: 'Text' })).reading.status, 'unread');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid reading data cannot overwrite saved progress or article contents', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-reading-invalid-'));
  try {
    const store = new ArticleStore(dir); await store.init();
    const article = await store.add({ title: 'Article', original: 'Original text' });
    const valid = { status: 'reading', lastMode: 'translated', positions: { translated: { scrollY: 120, progress: 30, heading: 'Chapter' } } };
    await store.updateReading(article.id, valid);
    const before = await readFile(store.file, 'utf8');
    for (const invalid of [null, [], { ...valid, status: 'ready' }, { ...valid, lastMode: '__proto__' }, { ...valid, positions: [] },
      ...[{ scrollY: -1 }, { scrollY: '120' }, { scrollY: Infinity }, { progress: 101 }, { heading: 'x'.repeat(251) }].map(patch => ({ ...valid, positions: { translated: { ...valid.positions.translated, ...patch } } }))]) {
      await assert.rejects(() => store.updateReading(article.id, invalid), /阅读/);
    }
    assert.equal(await readFile(store.file, 'utf8'), before);
    assert.equal(article.original, 'Original text');
    await assert.rejects(() => store.updateReading('missing', valid), /文章不存在/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('translation retries transient failures, keeps finished chunks and resumes only for the same language', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-translation-resume-'));
  try {
    const article = { title: 'Test', original: 'A'.repeat(8500) + '\n\n' + 'B'.repeat(8500) };
    const waits = []; const prompts = []; const drafts = []; let timeouts = 1;
    const wait = async ms => { waits.push(ms); };
    const flaky = async (provider, prompt) => {
      prompts.push(prompt);
      if (prompt.includes('BBBB') && timeouts-- > 0) throw Object.assign(new Error('模型服务响应超时，原文已保留，可以重试。'), { code: 'MODEL_TIMEOUT' });
      return prompt.includes('AAAA') ? 'first' : 'second';
    };
    const result = await translateArticle(article, 'api', dir, () => {}, flaky, { language: 'en', wait, onChunk: async draft => drafts.push(draft) });
    assert.equal(result, 'first\n\nsecond'); assert.deepEqual(waits, [5000]); assert.equal(prompts.length, 3);
    assert.match(prompts[0], /Target language: English/);
    assert.deepEqual(drafts.at(-1).parts, ['first', 'second']);

    // Permissions errors fail at once and report how much is already saved.
    const denied = async (provider, prompt) => {
      if (prompt.includes('BBBB')) throw Object.assign(new Error('模型服务拒绝访问。'), { code: 'MODEL_HTTP', status: 401 });
      return 'first';
    };
    let draft;
    await assert.rejects(() => translateArticle(article, 'api', dir, () => {}, denied, { language: 'en', wait, onChunk: async value => { draft = value; } }),
      error => /已保存 1 \/ 2 段，重试会从第 2 段继续/.test(error.message) && error.code === 'MODEL_HTTP');
    assert.deepEqual(waits, [5000]);

    const resumed = []; const resume = async (provider, prompt) => { resumed.push(prompt); return 'second'; };
    assert.equal(await translateArticle(article, 'api', dir, () => {}, resume, { language: 'en', draft }), 'first\n\nsecond');
    assert.equal(resumed.length, 1); assert.match(resumed[0], /BBBB/);
    // A different target language starts over instead of mixing languages.
    resumed.length = 0;
    await translateArticle(article, 'api', dir, () => {}, resume, { language: 'ja', draft });
    assert.equal(resumed.length, 2); assert.match(resumed[0], /日本語/);
    await assert.rejects(() => translateArticle(article, 'api', dir, () => {}, resume, { language: 'xx' }), /不支持的目标语言/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('browser locales map to supported target languages', () => {
  assert.equal(languageFromLocale('en-US'), 'en'); assert.equal(languageFromLocale('zh-CN'), 'zh-CN');
  assert.equal(languageFromLocale('zh-Hant-HK'), 'zh-TW'); assert.equal(languageFromLocale('zh-TW'), 'zh-TW'); assert.equal(languageFromLocale('zh'), 'zh-CN');
  assert.equal(languageFromLocale('pt-PT'), 'pt-BR'); assert.equal(languageFromLocale('ja'), 'ja');
  assert.equal(languageFromLocale('sv-SE'), null); assert.equal(languageFromLocale(''), null);
});

test('page errors explain the likely cause and point to pasting', () => {
  assert.match(pageStatusError(403).message, /拒绝了程序访问.*「粘贴」/);
  assert.match(pageStatusError(404).message, /页面不存在/);
  assert.match(pageStatusError(429).message, /访问频率.*稍后/);
  assert.match(pageStatusError(503).message, /暂时出错/);
  assert.equal(pageStatusError(403).code, 'FETCH_HTTP');
});

const xLoginShellHTML = `<html><head><title>writer on X: "A long post" / X</title></head><body><h2>Log in or sign up for X</h2><a href="/i/jf/onboarding/web?mode=login">Log in</a><article><p>${'Sidebar card text that is long enough to pass the readability threshold. '.repeat(12)}</p></article></body></html>`;

test('X links that only reach the login page fail instead of saving the shell', async () => {
  await assert.rejects(() => fetchArticleHTML('https://x.com/writer/article/123', 0, {
    resolveAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
    requestPage: async () => ({ redirect: 'https://x.com/i/jf/onboarding/web?mode=login' }),
  }), error => error.code === 'X_LOGIN_REQUIRED');
  assert.throws(() => extractArticle(xLoginShellHTML, 'https://x.com/writer/status/123'), /粘贴/);
  // The same markup on another site still goes through normal extraction.
  assert.match(extractArticle(xLoginShellHTML, 'https://example.com/post').original, /Sidebar card text/);
  const text = 'A real post body that X shipped to a reader without an account. '.repeat(4);
  assert.match(extractArticle(`<html><body><article><div data-testid="tweetText">${text}</div></article></body></html>`, 'https://x.com/writer/status/123').original, /A real post body/);
  const view = extractArticle(`<html><head><meta property="og:title" content="A long article / X"></head><body><nav>${'Timeline chrome. '.repeat(30)}</nav><div data-testid="twitterArticleRichTextView"><h2>Section</h2><p>${text}</p></div></body></html>`, 'https://x.com/writer/article/123');
  assert.equal(view.title, 'A long article'); assert.match(view.original, /## Section/); assert.doesNotMatch(view.original, /Timeline chrome/);
});

test('translation preserves every chunk and propagates provider failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiye-translation-'));
  try {
    const article = { title: 'Test', original: 'A'.repeat(8500) + '\n\n' + 'B'.repeat(8500) };
    const progress = []; let calls = 0;
    const result = await translateArticle(article, 'codex', dir, (i, n) => progress.push([i, n]), async (provider, prompt) => {
      assert.equal(provider, 'codex'); assert.match(prompt, /不要调用任何工具/); assert.match(prompt, /已有一级标题要保留一级标题层级并翻译标题文字/); assert.match(prompt, /不要使用下划线作为强调标记/); assert.match(prompt, /代码和链接地址中的下划线必须原样保留/); assert.match(prompt, /<article-data>/); return `译文${++calls}`;
    });
    assert.equal(result, '译文1\n\n译文2'); assert.deepEqual(progress, [[0, 2], [1, 2]]);
    await assert.rejects(() => translateArticle(article, 'agy', dir, () => {}, async () => { throw new Error('provider unavailable'); }), /provider unavailable/);
    await assert.rejects(() => runAgent('unknown', '', dir), /请选择/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
