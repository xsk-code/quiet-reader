import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImageQueue, translateImage } from '../lib/images.mjs';
import { ArticleStore } from '../lib/store.mjs';
import { imageRateLimitError } from '../lib/translate.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const source = 'https://example.com/diagram.png';
const output = JSON.stringify({ status: 'done', kind: 'chart', summary: '保持原图配色', scene: { width: 200, height: 100, background: '#e7dfd4', elements: [{ type: 'text', x: 20, y: 30, text: '中文', fontSize: 7.5 }] } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'expected queue transition did not occur');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

test('two global workers process images within and across articles without losing out-of-order replacements', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-pool-'));
  const gates = Array.from({ length: 4 }, deferred), started = Array.from({ length: 4 }, deferred);
  let queue;
  try {
    const store = new ArticleStore(directory); await store.init();
    const originals = ['![a](https://example.com/0.png)\n\n![b](https://example.com/1.png)\n\n![c](https://example.com/2.png)', '![d](https://example.com/3.png)'];
    const articles = [];
    for (const original of originals) {
      const article = await store.add({ title: 'Article', original });
      await store.update(article.id, { status: 'ready', translated: original }); articles.push(article);
    }
    let active = 0, maximum = 0;
    queue = new ImageQueue(store, { translate: async (item, _directory, { onProgress }) => {
      const index = Number(new URL(item.source).pathname.match(/\d/)[0]);
      maximum = Math.max(maximum, ++active); started[index].resolve();
      await onProgress({ stage: 'recognizing', stageStartedAt: new Date().toISOString() });
      await gates[index].promise; active--;
      return { status: 'done', filename: 'translated.svg' };
    } });
    await queue.start(articles[0].id); await queue.start(articles[1].id);
    await Promise.all([started[0].promise, started[1].promise]);
    assert.equal(active, 2); assert.equal(articles[1].imageTranslation.items[0].status, 'queued');
    gates[1].resolve(); await started[2].promise;
    gates[2].resolve(); await started[3].promise;
    assert.equal(articles[0].imageTranslation.items[0].status, 'running');
    gates[3].resolve(); gates[0].resolve(); await queue.queue;
    assert.equal(maximum, 2);
    for (const article of articles) {
      assert.equal(article.imageTranslation.status, 'done'); assert.equal(article.original, originals[articles.indexOf(article)]);
      for (const item of article.imageTranslation.items) {
        assert(article.translated.includes(item.url)); assert(Number.isFinite(item.timings.queueMs));
      }
    }
    for (const concurrency of [0, 5, 1.5, NaN]) assert.throws(() => new ImageQueue(store, { concurrency }), /IMAGE_CONCURRENCY/);
  } finally { gates.forEach(gate => gate.resolve()); await queue?.queue; await rm(directory, { recursive: true, force: true }); }
});

test('rate limits pause queued images while an already running request can finish', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-pool-quota-'));
  const gates = [deferred(), deferred()]; let queue;
  try {
    const store = new ArticleStore(directory); await store.init();
    const article = await store.add({ title: 'Quota', original: [0, 1, 2, 3].map(n => `![${n}](https://example.com/${n}.png)`).join('\n\n') });
    await store.update(article.id, { translated: article.original, status: 'ready' });
    let calls = 0;
    queue = new ImageQueue(store, { translate: async item => {
      calls++; const index = Number(new URL(item.source).pathname.match(/\d/)[0]);
      await gates[index].promise;
      if (index === 0) throw imageRateLimitError('429 RESOURCE_EXHAUSTED');
      return { status: 'done', filename: 'translated.svg' };
    } });
    await queue.start(article.id); await until(() => calls === 2);
    gates[0].resolve(); await until(() => article.imageTranslation.items[3].status === 'error');
    assert.equal(article.imageTranslation.status, 'running');
    assert.equal(calls, 2); gates[1].resolve(); await queue.queue;
    assert.equal(article.imageTranslation.status, 'error');
    assert.equal(article.imageTranslation.items[1].status, 'done');
    assert.equal(article.imageTranslation.items[2].errorCode, 'IMAGE_RATE_LIMIT');
  } finally { gates.forEach(gate => gate.resolve()); await queue?.queue; await rm(directory, { recursive: true, force: true }); }
});

test('render failures preserve recognition and retry replays locally after restart without downloading or calling the model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-replay-'));
  try {
    await mkdir(path.join(directory, 'translated.svg'));
    let calls = 0;
    await assert.rejects(() => translateImage({ source }, directory, { download: async () => png, agent: async () => { calls++; return output; } }), error => error.imageTimings.failedStage === 'rendering');
    const record = JSON.parse(await readFile(path.join(directory, 'recognition.json'), 'utf8'));
    assert.equal(record.output, output);
    const failed = JSON.parse(await readFile(path.join(directory, 'timings.json'), 'utf8'));
    assert.equal(failed.failedStage, 'rendering'); assert(Number.isFinite(failed.recognizingMs));
    await rm(path.join(directory, 'translated.svg'), { recursive: true });
    const events = [];
    const result = await translateImage({ source }, directory, {
      download: async () => { throw new Error('must not download again'); },
      agent: async () => { throw new Error('must not recognize again'); },
      onProgress: async event => events.push(event.stage),
    });
    assert.equal(calls, 1); assert.equal(result.timings.mode, 'replay'); assert.equal(result.timings.sourceMode, 'local');
    assert(events.includes('replaying')); assert(!events.includes('recognizing'));
    assert.match(await readFile(path.join(directory, 'translated.svg'), 'utf8'), /#e7dfd4/);
    assert.match(await readFile(path.join(directory, 'translated.svg'), 'utf8'), /font-size="7.50"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid model output is retained with its failure stage and cannot poison the content cache', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-replay-invalid-'));
  const cache = new Map(); let calls = 0;
  try {
    const invalid = output.replace('"fontSize":7.5', '"fontSize":0');
    await assert.rejects(() => translateImage({ source }, directory, { cache, download: async () => png, agent: async () => { calls++; return invalid; } }), error => error.code === 'IMAGE_VALIDATION');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'recognition.json'), 'utf8')).output, invalid);
    assert.equal(cache.size, 0);
    // A local schema/data repair can reuse the expensive output while keeping strict validation.
    const record = JSON.parse(await readFile(path.join(directory, 'recognition.json'), 'utf8'));
    record.output = output; await writeFile(path.join(directory, 'recognition.json'), JSON.stringify(record));
    const result = await translateImage({ source }, directory, { cache, agent: async () => { calls++; throw new Error('must replay'); }, download: async () => { throw new Error('must reuse original'); } });
    assert.equal(result.timings.mode, 'replay'); assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unchanged invalid recognition falls back to one fresh call instead of getting stuck replaying', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-replay-fresh-'));
  try {
    await assert.rejects(() => translateImage({ source }, directory, { download: async () => png, agent: async () => 'not JSON' }));
    let calls = 0;
    const result = await translateImage({ source }, directory, { download: async () => { throw new Error('use local source'); }, agent: async () => { calls++; return output; } });
    assert.equal(calls, 1); assert.equal(result.timings.mode, 'model'); assert.equal(result.timings.replayFailureCode, 'IMAGE_VALIDATION');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'recognition.json'), 'utf8')).output, output);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recognition replay is bound to the source URL and actual original bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-replay-source-'));
  try {
    let calls = 0;
    const options = { download: async () => png, agent: async () => { calls++; return output; } };
    await translateImage({ source }, directory, options);
    await writeFile(path.join(directory, 'source.png'), Buffer.from('damaged image'));
    const changed = await translateImage({ source }, directory, { ...options, download: async () => Buffer.concat([png, Buffer.from('new pixels')]) });
    assert.equal(changed.timings.mode, 'model'); assert.equal(calls, 2);
    const another = await translateImage({ source: 'https://example.com/other.png' }, directory, options);
    assert.equal(another.timings.mode, 'model'); assert.equal(calls, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('simultaneous identical images share one recognition and persist their own files and timings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-shared-'));
  const cache = new Map(), gate = deferred(); let calls = 0, waiting = false;
  let tasks;
  try {
    const options = { cache, download: async () => png, onProgress: async event => { if (event.stage === 'waiting') waiting = true; }, agent: async (_provider, _prompt, _cwd, settings) => {
      calls++; settings.onStarted({ pid: 123 }); await gate.promise; return output;
    } };
    tasks = [
      translateImage({ source }, path.join(directory, 'a'), options),
      translateImage({ source: 'https://example.com/copy.png' }, path.join(directory, 'b'), options),
    ];
    await until(() => calls === 1 && waiting);
    gate.resolve(); const results = await Promise.all(tasks);
    assert.equal(calls, 1); assert.deepEqual(results.map(result => result.timings.mode).sort(), ['model', 'shared']);
    for (const folder of ['a', 'b']) {
      assert.match(await readFile(path.join(directory, folder, 'translated.svg'), 'utf8'), /中文/);
      const timings = JSON.parse(await readFile(path.join(directory, folder, 'timings.json'), 'utf8'));
      assert(Number.isFinite(timings.totalMs)); assert(Date.parse(timings.finishedAt) >= Date.parse(timings.startedAt));
    }
  } finally { gate.resolve(); await Promise.allSettled(tasks || []); await rm(directory, { recursive: true, force: true }); }
});

test('a failed shared recognition records separate timings and releases the cache for retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiye-shared-failure-'));
  const cache = new Map(), gate = deferred(); let calls = 0, waiting = false, tasks;
  try {
    const options = { cache, download: async () => png, onProgress: async event => { if (event.stage === 'waiting') waiting = true; }, agent: async () => { calls++; await gate.promise; return 'invalid JSON'; } };
    tasks = ['a', 'b'].map(name => translateImage({ source }, path.join(directory, name), options));
    const settled = Promise.allSettled(tasks);
    await until(() => calls === 1 && waiting); gate.resolve();
    const results = await settled;
    assert(results.every(result => result.status === 'rejected' && result.reason.code === 'IMAGE_VALIDATION'));
    assert.notEqual(results[0].reason, results[1].reason);
    assert.deepEqual(results.map(result => result.reason.imageTimings.mode).sort(), ['model', 'shared']);
    assert.equal(cache.size, 0);
    const retried = await Promise.all(['a', 'b'].map(name => translateImage({ source }, path.join(directory, name), { cache, download: async () => png, agent: async () => { calls++; return output; } })));
    assert.equal(calls, 2); assert(retried.every(result => result.status === 'done'));
  } finally { gate.resolve(); await Promise.allSettled(tasks || []); await rm(directory, { recursive: true, force: true }); }
});
