import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { validateInsight, flowchartSVG, imageInsightsMarkdown } from '../lib/image-insights.mjs';

const diagram = {
  kind: 'flowchart', summary: '输入后输出。',
  diagram: { nodes: [{ id: 'a', label: '<script>alert(1)</script>' }, { id: 'b', label: '输出' }], edges: [{ from: 'a', to: 'b', label: '完成' }] },
};

test('insights reject malformed tables, dangling edges and oversized data, discarding model markup', () => {
  const valid = validateInsight({ ...diagram, html: '<script/>', path: '/tmp/secret' });
  assert.equal(valid.html, undefined); assert.equal(valid.path, undefined);
  for (const input of [null, {}, { kind: 'text', summary: 'x'.repeat(4001) },
    { kind: 'table', summary: '表格', table: { headers: ['A'], rows: [['1', '2']] } },
    { ...diagram, diagram: { nodes: diagram.diagram.nodes, edges: [{ from: 'a', to: 'missing' }] } },
    { ...diagram, diagram: { nodes: [diagram.diagram.nodes[0], diagram.diagram.nodes[0]], edges: [] } },
    { ...diagram, diagram: { nodes: Array.from({ length: 13 }, (_, i) => ({ id: String(i), label: '节点' })), edges: [] } },
  ]) assert.throws(() => validateInsight(input));
});

test('SVG uses literal model labels and contains no executable model content', () => {
  const svg = flowchartSVG(diagram);
  const document = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
  assert.equal(document.querySelectorAll('script, foreignObject, image, a').length, 0);
  assert.ok(document.documentElement.textContent.includes('<script>alert(1)</script>'));
  assert.ok(!svg.includes('undefined'));
  assert.equal(document.querySelector('svg').getAttribute('role'), 'img');
});

test('independent workflow chains render on separate rows without invented connecting arrows', () => {
  const insight = { kind: 'flowchart', summary: '两种任务分工。', diagram: {
    nodes: ['feature', 'tests', 'review', 'combined', 'verifier'].map(id => ({ id, label: id })),
    edges: [{ from: 'feature', to: 'tests' }, { from: 'tests', to: 'review' }, { from: 'combined', to: 'verifier' }],
  } };
  const svg = flowchartSVG(insight);
  const document = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
  const boxes = [...document.querySelectorAll('rect')];
  assert.equal(boxes.length, 5);
  assert.equal(boxes[0].getAttribute('y'), boxes[2].getAttribute('y'));
  assert.equal(boxes[3].getAttribute('y'), boxes[4].getAttribute('y'));
  assert.notEqual(boxes[0].getAttribute('y'), boxes[3].getAttribute('y'));
  assert.equal(document.querySelectorAll('path').length, 6);
  assert.doesNotMatch(document.querySelector('svg').getAttribute('aria-label'), /review → combined/);
});

test('Markdown export includes searchable translations, table, relationships and uncertainties as literal text', () => {
  const items = [
    { status: 'done', source: 'https://example.com/a.png', insight: { ...diagram, originalText: 'Input', translatedText: '<img src=x onerror=alert(1)>', uncertainties: ['数值无法确认'] } },
    { status: 'done', source: 'https://example.com/b.png', insight: { kind: 'table', summary: '表格', table: { headers: ['项目', '值'], rows: [['A|B', '10']] } } },
    { status: 'error', insight: diagram }, { status: 'done', insight: {} },
  ];
  const markdown = imageInsightsMarkdown(items);
  assert.match(markdown, /流程关系/); assert.match(markdown, /→ 输出：完成/);
  assert.match(markdown, /数值无法确认/); assert.match(markdown, /https:\/\/example.com\/a.png/);
  const document = JSDOM.fragment(marked.parse(markdown));
  assert.equal(document.querySelector('img, script'), null);
  assert.ok(document.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(document.querySelector('tbody td').textContent, 'A|B');
  assert.equal(imageInsightsMarkdown([]), '');
});
