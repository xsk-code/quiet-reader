import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleToMarkdown, fetchXArticle, statusPath, xAPIBase, xArticleFromJSON } from '../lib/xarticle.mjs';

const link = url => ({ value: { type: 'LINK', data: { url } } });

test('X status links map to the public API path', () => {
  assert.equal(statusPath('https://x.com/jsnnsa/status/2115623382721126826'), '/jsnnsa/status/2115623382721126826');
  assert.equal(statusPath('https://twitter.com/writer/status/123?s=20'), '/writer/status/123');
  assert.equal(statusPath('https://mobile.x.com/writer/status/123/photo/1'), '/writer/status/123');
  assert.equal(statusPath('https://x.com/i/status/123'), '/i/status/123');
  for (const url of ['https://x.com/i/article/123', 'https://example.com/writer/status/123', 'https://x.com/writer', 'nope']) {
    assert.equal(statusPath(url), '', url);
  }
});

test('the public API can be pointed at a self-hosted deployment or turned off', () => {
  assert.equal(xAPIBase({}), 'https://api.fxtwitter.com');
  assert.equal(xAPIBase({ READER_X_API: 'https://fx.example.com/' }), 'https://fx.example.com');
  assert.equal(xAPIBase({ READER_X_API: 'off' }), '');
});

test('Draft.js blocks become readable Markdown', () => {
  const article = {
    content: {
      blocks: [
        { type: 'header-two', text: 'The fleet' },
        { type: 'unstyled', text: 'Spawn is ten people.', inlineStyleRanges: [{ offset: 0, length: 5, style: 'Bold' }] },
        { type: 'blockquote', text: 'A tight loop only works if it never stops.' },
        { type: 'unordered-list-item', depth: 0, text: 'first' },
        { type: 'unordered-list-item', depth: 1, text: 'nested' },
        { type: 'atomic', text: ' ', entityRanges: [{ offset: 0, length: 1, key: 0 }] },
        { type: 'unstyled', text: 'Read the wiki', entityRanges: [{ offset: 5, length: 8, key: 1 }] },
      ],
      entityMap: {
        0: { value: { type: 'MEDIA', data: { mediaItems: [{ mediaId: '42' }] } } },
        1: link('https://en.wikipedia.org/wiki/Stigmergy'),
      },
    },
    media_entities: [{ media_id: '42', media_info: { original_img_url: 'https://pbs.twimg.com/media/x.jpg' } }],
  };
  const markdown = articleToMarkdown(article);
  assert.match(markdown, /^## The fleet/m);
  assert.match(markdown, /\*\*Spawn\*\* is ten people\./);
  assert.match(markdown, /^> A tight loop/m);
  assert.match(markdown, /^- first\n {2}- nested/m);
  assert.match(markdown, /!\[图片\]\(https:\/\/pbs\.twimg\.com\/media\/x\.jpg\)/);
  assert.match(markdown, /Read \[the wiki\]\(https:\/\/en\.wikipedia\.org\/wiki\/Stigmergy\)/);
});

test('an article payload yields title, author and the full body', () => {
  const body = 'Spawn is ten people and the fleet ships hourly. '.repeat(4);
  const article = xArticleFromJSON({
    tweet: {
      text: 'https://t.co/link',
      author: { name: 'jacob', screen_name: 'jsnnsa' },
      article: { title: 'How I Built the Most AI-Pilled Company', preview_text: 'Spawn is ten people.', content: { blocks: [{ type: 'unstyled', text: body }], entityMap: {} }, media_entities: [] },
    },
  }, 'https://x.com/jsnnsa/status/1');
  assert.equal(article.title, 'How I Built the Most AI-Pilled Company');
  assert.equal(article.author, 'jacob @jsnnsa');
  assert.equal(article.siteName, 'X (formerly Twitter)');
  assert.ok(article.original.includes('Spawn is ten people'));
});

test('a plain post still imports, and empty payloads are rejected', () => {
  const post = xArticleFromJSON({
    tweet: {
      text: 'The coding interview is dead, at least for my team. I removed it from loops this month, and I think that is good news for juniors.',
      author: { name: 'Felix', screen_name: 'felixrieseberg' },
      media: { photos: [{ url: 'https://pbs.twimg.com/media/a.jpg' }] },
    },
  }, 'https://x.com/felixrieseberg/status/2');
  assert.match(post.original, /coding interview/);
  assert.match(post.original, /!\[图片\]\(https:\/\/pbs\.twimg\.com\/media\/a\.jpg\)/);
  assert.equal(xArticleFromJSON({ tweet: { text: '' } }, 'https://x.com/w/status/3'), null);
  assert.equal(xArticleFromJSON({ code: 404 }, 'https://x.com/w/status/3'), null);
});

test('the public reader fetches through the configured endpoint and reports misses clearly', async () => {
  const calls = [];
  const article = await fetchXArticle('https://x.com/writer/status/123', {
    env: { READER_X_API: 'https://fx.example.com' },
    fetchJSON: async url => {
      calls.push(url);
      return { tweet: { text: 'A short post that is long enough to be imported as an article body.', author: { name: 'W', screen_name: 'writer' } } };
    },
  });
  assert.deepEqual(calls, ['https://fx.example.com/writer/status/123']);
  assert.match(article.original, /short post/);

  await assert.rejects(() => fetchXArticle('https://x.com/writer/status/123', { env: { READER_X_API: 'off' } }), /粘贴/);
  await assert.rejects(() => fetchXArticle('https://x.com/writer/status/123', { env: {}, fetchJSON: async () => ({ code: 404, message: 'NOT_FOUND' }) }), /粘贴/);
});
