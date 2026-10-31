import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { articleImages, replaceImageURLs, translateImage, ImageQueue, fetchImage, imageDimensions, loadImageCache } from '../lib/images.mjs';
import { ArticleStore } from '../lib/store.mjs';
import { imageRateLimitError, runAgent } from '../lib/translate.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const source = 'https://example.com/chart.png?x=1&y=2';
const skipWindowsAgent = process.platform === 'win32' ? 'Windows local CLI agents are unsupported' : false;

test('source PNG and GIF dimensions retain the real image aspect ratio', () => {
  assert.deepEqual(imageDimensions(png), { width: 1, height: 1 });
  const gif = Buffer.from('GIF89a0000'); gif.writeUInt16LE(2024, 6); gif.writeUInt16LE(884, 8);
  assert.deepEqual(imageDimensions(gif), { width: 2024, height: 884 });
  assert.equal(imageDimensions(Buffer.from('invalid')), null);
});

test('reads baseline and progressive JPEG and extended, lossless and lossy WebP dimensions safely', () => {
  for (const marker of [0xc0, 0xc2]) {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, marker, 0, 8, 8, 0x03, 0xe8, 0x07, 0xd0, 0]);
    assert.deepEqual(imageDimensions(jpg), { width: 2000, height: 1000 });
    assert.equal(imageDimensions(jpg.subarray(0, 8)), null);
  }
  for (const type of ['VP8X', 'VP8L', 'VP8 ']) {
    const webp = Buffer.alloc(32); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write(type, 12);
    if (type === 'VP8X') { webp.writeUIntLE(1999, 24, 3); webp.writeUIntLE(999, 27, 3); }
    if (type === 'VP8L') { webp[20] = 0x2f; webp.writeUInt32LE(1999 | (999 << 14), 21); }
    if (type === 'VP8 ') { Buffer.from([0x9d, 0x01, 0x2a]).copy(webp, 23); webp.writeUInt16LE(2000, 26); webp.writeUInt16LE(1000, 28); }
    assert.deepEqual(imageDimensions(webp), { width: 2000, height: 1000 });
  }
});

test('identical image bytes from different URLs reuse recognition and save independent article files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-cache-'));
  const cache = new Map(); let calls = 0;
  const options = { cache, download: async () => png, agent: async () => {
    calls++; return JSON.stringify({ status: 'done', kind: 'text', summary: '相同原图', scene: { width: 200, height: 100, elements: [{ type: 'text', text: '中文' }] } });
  } };
  try {
    const first = await translateImage({ source }, path.join(directory, 'a'), options);
    const second = await translateImage({ source: 'https://example.com/duplicate.png' }, path.join(directory, 'b'), options);
    assert.equal(calls, 1); assert.deepEqual(first.insight, second.insight);
    assert.equal(first.timings.mode, 'model'); assert.equal(second.timings.mode, 'cache');
    assert.match(await readFile(path.join(directory, 'b', 'translated.svg'), 'utf8'), /中文/);
    assert.deepEqual(await readFile(path.join(directory, 'a', 'source.png')), await readFile(path.join(directory, 'b', 'source.png')));
    assert.equal(cache.size, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the same image is recognized again for another target language and the prompt names it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-language-'));
  const cache = new Map(); const prompts = [];
  const options = { cache, download: async () => png, agent: async (provider, prompt) => {
    prompts.push(prompt); return JSON.stringify({ status: 'done', kind: 'text', summary: 'summary', scene: { width: 200, height: 100, elements: [{ type: 'text', text: 'Hello' }] } });
  } };
  try {
    const chinese = await translateImage({ source }, path.join(directory, 'a'), options);
    const english = await translateImage({ source }, path.join(directory, 'b'), { ...options, language: 'en' });
    const englishAgain = await translateImage({ source }, path.join(directory, 'c'), { ...options, language: 'en' });
    assert.equal(prompts.length, 2); assert.match(prompts[0], /翻译成简体中文/); assert.match(prompts[1], /翻译成English/);
    assert.equal(chinese.language, 'zh-CN'); assert.equal(english.language, 'en'); assert.equal(englishAgain.timings.mode, 'cache');
    // A Chinese recognition record on disk must not be replayed for English.
    const replayed = await translateImage({ source }, path.join(directory, 'a'), { download: async () => png, language: 'en', agent: options.agent });
    assert.equal(replayed.timings.mode, 'model'); assert.equal(prompts.length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup restores successful content cache and ignores missing or invalid entries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-warm-cache-'));
  try {
    const store = new ArticleStore(directory); await store.init();
    const article = await store.add({ title: 'A', original: `![image](${source})` });
    const item = articleImages(article.original)[0];
    const imageDirectory = path.join(directory, 'articles', article.id, 'images', item.id);
    const result = await translateImage(item, imageDirectory, { download: async () => png, agent: async () => JSON.stringify({ status: 'done', kind: 'text', summary: '已识别', scene: { width: 100, height: 100, elements: [{ type: 'text', text: '中文' }] } }) });
    await store.update(article.id, { translated: article.original, imageTranslation: { status: 'done', items: [{ ...item, ...result }, { id: 'a'.repeat(24), status: 'done', insight: { kind: 'text', summary: '文件缺失' } }, { id: '../invalid', status: 'skipped' }] } });
    const cache = await loadImageCache(store); assert.equal(cache.size, 1);
    const reused = await translateImage({ source: 'https://example.com/duplicate.png' }, path.join(directory, 'new-image'), { cache, download: async () => png, agent: async () => { throw new Error('must not call the model'); } });
    assert.equal(reused.status, 'done'); assert.equal(reused.insight.summary, '已识别');
    assert.match(await readFile(path.join(directory, 'new-image', 'translated.svg'), 'utf8'), /中文/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('image agent launches directly with the image tool profile and a longer timeout', { skip: skipWindowsAgent }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-cli-'));
  const previous = process.env.AGY_BIN;
  try {
    const executable = path.join(directory, 'fake-agy.mjs');
    await writeFile(executable, `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[args.indexOf('--agent')+1]!=='quiet-reader-image')process.exit(41);if(args[args.indexOf('--model')+1]!=='gemini-3.8-flash-high')process.exit(42);if(args[args.indexOf('--print-timeout')+1]!=='540s')process.exit(43);if(!args.includes('--sandbox')||args.includes('--dangerously-skip-permissions'))process.exit(44);process.stdout.write('{"status":"skipped"}');\n`, { mode: 0o700 });
    process.env.AGY_BIN = executable;
    assert.equal(await runAgent('agy', 'Inspect the image', directory, { image: true }), '{"status":"skipped"}');
  } finally {
    if (previous === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('finds unique actual images including references, HTML and standalone URLs, ignoring code and unsafe URLs', () => {
  const markdown = `![chart](${source})\n\n![again][chart]\n\n[chart]: ${source}\n\n<img src="https://example.com/other.jpg">\n\nhttps://example.com/plain.webp\n\n\`![literal](https://example.com/code.png)\`\n\n\`\`\`md\n![literal](https://example.com/code2.png)\n\`\`\`\n\n![unsafe](file:///tmp/secret.png)`;
  assert.deepEqual(articleImages(markdown).map(item => item.source), [source, 'https://example.com/other.jpg', 'https://example.com/plain.webp']);
});

test('split Substack image wrappers do not treat the full-size link target as a second image', () => {
  const image = 'https://example.com/resized.png', target = 'https://example.com/full.png';
  const wrapper = `[\n\n![图](${image})\n\n](${target})`;
  assert.deepEqual(articleImages(wrapper).map(item => item.source), [image]);
  assert.deepEqual(articleImages(`\`\`\`md\n${wrapper}\n\`\`\``), []);
  assert.deepEqual(articleImages(`${wrapper}\n\n${target}`).map(item => item.source), [image, target]);
});

test('rewrites only image destinations, preserving prose, source links and code', () => {
  const target = '/media/article/image/translated.png';
  const image = `![chart](${source})`;
  const literal = `\`\`\`md\n${image}\n\`\`\``;
  const content = `${image}\n\n[original](${source})\n\nURL ${source}\n\n\`${image}\`\n\n${literal}\n\n    ${image}\n\n> ${image}\n\n![reference][ref]\n\n[ref]: ${source}\n\n<img src="${source.replace('&', '&amp;')}">`;
  const result = replaceImageURLs(content, new Map([[source, target]]));
  assert.match(result, /!\[chart\]\(\/media\/article\/image\/translated.png\)/);
  assert.ok(result.includes(`[original](${source})`));
  assert.ok(result.includes(`URL ${source}`));
  assert.ok(result.includes(`\`${image}\``));
  assert.ok(result.includes(literal));
  assert.ok(result.includes(`    ${image}`));
  assert.ok(result.includes(`> ![chart](${target})`));
  assert.ok(result.includes(`![reference](${target})`));
  assert.ok(result.includes(`<img src="${target}">`));
  const unicodeSource = 'https://example.com/图.png';
  assert.equal(replaceImageURLs(`![图](${unicodeSource})`, new Map([[new URL(unicodeSource).href, target]])), `![图](${target})`);
  const unquotedSource = 'https://example.com/chart.png';
  assert.equal(replaceImageURLs(`<img src=${unquotedSource} srcset="${unquotedSource} 2x">`, new Map([[unquotedSource, target]])), `<img src="${target}">`);
});

test('image understanding reads the source and saves structured insight without image generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-'));
  const insight = { kind: 'flowchart', summary: '从输入到阅读。', originalText: 'Input → Read', translatedText: '输入 → 阅读', uncertainties: [],
    diagram: { nodes: [{ id: 'a', label: '输入' }, { id: 'b', label: '阅读' }], edges: [{ from: 'a', to: 'b', label: '' }] } };
  try {
    const result = await translateImage({ source }, directory, {
      download: async url => { assert.equal(url, source); return png; },
      agent: async (provider, prompt, cwd, options = {}) => {
        assert.equal(provider, 'agy'); assert.equal(cwd, directory); assert.equal(options.image, true);
        assert.match(prompt, /只理解图片/); assert.match(prompt, /禁止子代理、终端/);
        assert.deepEqual(await readFile(path.join(cwd, 'source.png')), png);
        const profile = await readFile(path.join(cwd, '.agents', 'agents', 'quiet-reader-image.md'), 'utf8');
        assert.match(profile, /read_file/); assert.doesNotMatch(profile, /generate_image/);
        return JSON.stringify({ status: 'done', ...insight });
      },
    });
    assert.equal(result.status, 'done'); assert.deepEqual(result.insight, insight);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'insight.json'), 'utf8')), insight);
    assert.match(await readFile(path.join(directory, 'diagram.svg'), 'utf8'), /输入/);
    assert.equal((await translateImage({ source }, path.join(directory, 'skipped'), { download: async () => png, agent: async () => '{"status":"skipped"}' })).status, 'skipped');
    await assert.rejects(() => translateImage({ source }, path.join(directory, 'quota'), { download: async () => png, agent: async () => '429 Too Many Requests / RESOURCE_EXHAUSTED' }), error => error.code === 'IMAGE_RATE_LIMIT');
    for (const [index, output] of ['null', '{"status":"done","path":"/tmp/any.png"}', '{"status":"done","kind":"text"}'].entries()) {
      await assert.rejects(() => translateImage({ source }, path.join(directory, `invalid-${index}`), { download: async () => png, agent: async () => output }));
    }
    await assert.rejects(() => translateImage({ source }, path.join(directory, 'bad-format'), { download: async () => Buffer.from('<html>login</html>') }), /格式不支持/);
    await assert.rejects(() => fetchImage('http://127.0.0.1/chart.png'), /内网/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('quota exhaustion stops queued attempts across articles until an explicit retry', async () => {
  assert.equal(imageRateLimitError('{"status":"done","path":"/tmp/quota_chart.png"}'), null);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-quota-'));
  try {
    const store = new ArticleStore(directory); await store.init();
    const original = `![chart](${source})\n\n![other](https://example.com/other.png)`;
    const first = await store.add({ title: 'First', original });
    const second = await store.add({ title: 'Second', original });
    await store.update(first.id, { status: 'ready', translated: original });
    await store.update(second.id, { status: 'ready', translated: original });
    let calls = 0; let fail = true;
    const translate = async () => { calls++; if (fail) throw imageRateLimitError('RESOURCE_EXHAUSTED'); return { status: 'skipped' }; };
    const queue = new ImageQueue(store, { translate, concurrency: 1 });
    await queue.start(first.id); await queue.start(second.id); await queue.queue;
    assert.equal(calls, 1);
    for (const article of [first, second]) {
      assert.equal(article.imageTranslation.errorCode, 'IMAGE_RATE_LIMIT');
      assert.match(article.imageTranslation.error, /额度或调用频率/);
      assert.ok(article.imageTranslation.items.every(item => item.status === 'error'));
      assert.equal(article.translated, original);
    }
    const restarted = new ImageQueue(store, { translate });
    await restarted.start(second.id); await restarted.queue; assert.equal(calls, 1);
    fail = false; await restarted.start(first.id, { retry: true }); await restarted.queue;
    assert.equal(calls, 3); assert.equal(first.imageTranslation.status, 'done');
    assert.equal(first.imageTranslation.errorCode, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('faithful redraw writes a local SVG, replaces only translated image tokens and upgrades old insights on request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-redraw-'));
  const scene = { width: 600, height: 300, background: '#faf9f6', elements: [{ type: 'rect', x: 20, y: 20, width: 300, height: 100, rx: 12, fill: '#f5e2d5' }, { type: 'text', x: 40, y: 60, text: '共享上下文' }] };
  try {
    const store = new ArticleStore(directory); await store.init();
    const original = `![chart](${source})\n\n[原图](${source})`;
    const article = await store.add({ title: 'Article', original });
    await store.update(article.id, { status: 'ready', translated: original, imageTranslation: { status: 'done', items: [{ source, status: 'done', insight: { kind: 'flowchart', summary: '旧解读' } }] } });
    const queue = new ImageQueue(store, { translate: (item, cwd) => translateImage(item, cwd, { download: async () => png, agent: async () => JSON.stringify({ status: 'done', kind: 'flowchart', summary: '中文重绘', scene }) }) });
    await queue.start(article.id, { redraw: true }); await queue.queue;
    assert.equal(article.imageTranslation.status, 'done');
    const item = article.imageTranslation.items[0];
    assert.match(item.url, /translated\.svg$/);
    assert.match(article.translated, /!\[chart\]\(\/media\//);
    assert.ok(article.translated.includes(`[原图](${source})`)); assert.equal(article.original, original);
    assert.match(await readFile(path.join(directory, 'articles', article.id, 'images', item.id, 'translated.svg'), 'utf8'), /#f5e2d5/);
    assert.match(await readFile(path.join(directory, 'articles', article.id, 'translated.md'), 'utf8'), /images\/.*translated\.svg/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('text stays ready while images finish independently; failures retain originals and retry only failed images', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-queue-'));
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  try {
    const store = new ArticleStore(directory); await store.init();
    const content = `# Article\n\n![chart](${source})\n\n![other](https://example.com/other.png)`;
    const article = await store.add({ title: 'Article', original: content });
    await store.update(article.id, { translated: content, status: 'ready' });
    const calls = []; let fail = true;
    const queue = new ImageQueue(store, { translate: async item => {
      calls.push(item.source); await waiting;
      if (fail && item.source.includes('other')) throw new Error('provider failed');
      return { status: 'done', filename: 'translated.png' };
    } });
    await queue.start(article.id);
    assert.equal(store.get(article.id).status, 'ready');
    assert.match(store.get(article.id).translated, /example.com\/chart/);
    assert.ok(['queued', 'running'].includes(store.get(article.id).imageTranslation.status));
    await assert.rejects(() => queue.start(article.id), /正在解读/);
    release(); await queue.queue;
    assert.equal(store.get(article.id).status, 'ready');
    assert.equal(store.get(article.id).imageTranslation.status, 'error');
    assert.match(store.get(article.id).translated, /\/media\//);
    assert.match(store.get(article.id).translated, /https:\/\/example.com\/other.png/);
    assert.equal(store.get(article.id).original, content);
    assert.match(await readFile(path.join(directory, 'articles', article.id, 'translated.md'), 'utf8'), /images\/[a-f0-9]+\/translated.png/);
    fail = false; await queue.start(article.id); await queue.queue;
    assert.equal(store.get(article.id).imageTranslation.status, 'done');
    assert.deepEqual(calls, [source, 'https://example.com/other.png', 'https://example.com/other.png']);
  } finally { release(); await rm(directory, { recursive: true, force: true }); }
});

test('restart marks unfinished images retryable without losing text or successful images', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-restart-'));
  try {
    const store = new ArticleStore(directory); await store.init();
    const article = await store.add({ title: 'A', original: 'Source' });
    await store.update(article.id, { status: 'ready', translated: '# 中文\n\n正文', imageTranslation: { status: 'running', items: [{ status: 'done', source, url: '/media/saved.png' }, { status: 'running' }, { status: 'queued' }] } });
    const reloaded = new ArticleStore(directory); await reloaded.init();
    const restored = reloaded.get(article.id);
    assert.equal(restored.status, 'ready'); assert.equal(restored.translated, '# 中文\n\n正文');
    assert.equal(restored.imageTranslation.status, 'error');
    assert.deepEqual(restored.imageTranslation.items.map(item => item.status), ['done', 'error', 'error']);
    assert.equal(restored.imageTranslation.items[0].url, '/media/saved.png');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('structured insights preserve original image URLs, survive restart and export without the local server', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-insight-'));
  try {
    const store = new ArticleStore(directory); await store.init();
    const original = `![chart](${source})`;
    const article = await store.add({ title: 'Article', original });
    await store.update(article.id, { translated: original, status: 'ready' });
    const insight = { kind: 'chart', summary: '整体上升。', originalText: 'Growth', translatedText: '增长', uncertainties: ['精确数值看不清'] };
    let calls = 0;
    const queue = new ImageQueue(store, { translate: async () => { calls++; return { status: 'done', insight }; } });
    await queue.start(article.id); await queue.queue;
    assert.equal(article.translated, original); assert.equal(article.original, original);
    assert.equal(article.imageTranslation.items[0].url, undefined);
    const exported = await readFile(path.join(directory, 'articles', article.id, 'translated.md'), 'utf8');
    assert.match(exported, /图片解读 · AI 生成/); assert.match(exported, /整体上升/);
    assert.doesNotMatch(exported, /\/media\/|localhost|127\.0\.0\.1/);
    const reloaded = new ArticleStore(directory); await reloaded.init();
    assert.deepEqual(reloaded.get(article.id).imageTranslation.items[0].insight, insight);
    await queue.start(article.id, { retry: true }); await queue.queue; assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recognized photos and complex images retained after redraw are reused during explicit redraw', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-photo-'));
  try {
    const store = new ArticleStore(directory); await store.init();
    const original = `![photo](${source})\n\n![complex](https://example.com/complex.png)`;
    const article = await store.add({ title: 'Photo', original });
    await store.update(article.id, { translated: original, status: 'ready' });
    let calls = 0;
    const queue = new ImageQueue(store, { translate: async item => { calls++; return { status: 'done', insight: { kind: item.source === source ? 'photo' : 'other', summary: '保留原图。' } }; } });
    await queue.start(article.id, { redraw: true }); await queue.queue;
    await queue.start(article.id, { retry: true, redraw: true }); await queue.queue;
    assert.equal(calls, 2); assert.equal(article.translated, original);
    assert.equal(article.imageTranslation.status, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deleting an article during image generation does not resurrect it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-image-delete-'));
  let release; const waiting = new Promise(resolve => { release = resolve; });
  try {
    const store = new ArticleStore(directory); await store.init();
    const article = await store.add({ title: 'A', original: `![chart](${source})` });
    await store.update(article.id, { status: 'ready', translated: article.original });
    const queue = new ImageQueue(store, { translate: async () => { await waiting; return { status: 'done', filename: 'translated.png' }; } });
    await queue.start(article.id); await store.remove(article.id); release(); await queue.queue;
    assert.equal(store.get(article.id), undefined);
  } finally { release(); await rm(directory, { recursive: true, force: true }); }
});
