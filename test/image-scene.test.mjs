import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { validateScene, sceneSVG } from '../lib/image-scene.mjs';

const scene = { width: 1200, height: 600, background: '#faf9f6', elements: [
  { type: 'rect', x: 50, y: 80, width: 420, height: 200, rx: 24, fill: '#f5e2d5' },
  { type: 'text', x: 80, y: 140, text: '共享上下文\n编写功能与测试', fontSize: 32, fontWeight: 700, fill: '#242321', maxWidth: 360 },
  { type: 'path', d: 'M 470 180 C 540 180 570 180 650 180', stroke: '#b8b5aa', strokeWidth: 3, arrow: true },
] };

test('redraw preserves source geometry, colors, rounded corners, typography and arrows', () => {
  const document = new JSDOM(sceneSVG(scene), { contentType: 'image/svg+xml' }).window.document;
  assert.equal(document.querySelector('svg').getAttribute('viewBox'), '0 0 1200 600');
  assert.equal(document.querySelectorAll('rect')[0].getAttribute('fill'), '#faf9f6');
  const box = document.querySelectorAll('rect')[1];
  assert.equal(box.getAttribute('fill'), '#f5e2d5'); assert.equal(box.getAttribute('rx'), '24');
  assert.equal(box.getAttribute('x'), '50');
  assert.equal(document.querySelector('text').getAttribute('font-weight'), '700');
  assert.equal(document.querySelectorAll('tspan').length, 2);
  assert.equal(document.querySelector('marker path').getAttribute('fill'), '#b8b5aa');
});

test('redraw accepts literal text only and rejects active resources, invalid coordinates and oversized scenes', () => {
  const input = { ...scene, elements: [{ type: 'text', text: '<script>alert(1)</script>', fill: '#333333' }] };
  const document = new JSDOM(sceneSVG(input, '"/><script/>'), { contentType: 'image/svg+xml' }).window.document;
  assert.equal(document.querySelector('script, image, foreignObject, a'), null);
  assert.equal(document.querySelector('text').textContent, '<script>alert(1)</script>');
  for (const value of [
    { ...scene, background: 'url(https://example.com)' },
    { ...scene, elements: [{ type: 'image', href: 'https://example.com' }] },
    { ...scene, elements: [{ type: 'text', text: 'x', fill: '" onload="alert(1)' }] },
    { ...scene, elements: [{ type: 'path', d: '<script/>' }] },
    { ...scene, elements: [{ type: 'rect', x: NaN }] },
    { ...scene, elements: Array.from({ length: 351 }, () => ({ type: 'rect' })) },
  ]) assert.throws(() => validateScene(value));
});

test('long translated labels fit the original text region without altering the canvas', () => {
  const document = new JSDOM(sceneSVG({ ...scene, elements: [{ type: 'text', text: '这是一行较长的中文译文', fontSize: 40, maxWidth: 120 }] }), { contentType: 'image/svg+xml' }).window.document;
  assert.ok(Number(document.querySelector('text').getAttribute('font-size')) < 40);
  assert.equal(document.querySelector('svg').getAttribute('width'), '1200');
});

test('the original image dimensions take precedence over the model canvas aspect ratio', () => {
  const document = new JSDOM(sceneSVG({ ...scene, sourceSize: { width: 2024, height: 884 } }), { contentType: 'image/svg+xml' }).window.document;
  const svg = document.querySelector('svg');
  assert.equal(svg.getAttribute('width'), '2024'); assert.equal(svg.getAttribute('height'), '884');
  assert.equal(svg.getAttribute('viewBox'), '0 0 1200 600');
});

test('small title images retain their original dimensions while zero-sized canvases are rejected', () => {
  const small = { width: 185, height: 20, background: '#ffffff', elements: [{ type: 'text', x: 0, y: 16, text: '如何做出伟大成就', fontSize: 16, fill: '#800000' }] };
  const document = new JSDOM(sceneSVG(small), { contentType: 'image/svg+xml' }).window.document;
  assert.equal(document.querySelector('svg').getAttribute('height'), '20');
  assert.equal(document.querySelector('text').getAttribute('fill'), '#800000');
  assert.throws(() => validateScene({ ...small, height: 0 }));
});

test('dense diagrams retain small fractional source fonts without losing annotations', () => {
  const input = { ...scene, elements: [{ type: 'text', x: 100, y: 200, text: '密集图表中的细节注释', fontSize: 7.5 }] };
  const document = new JSDOM(sceneSVG(input), { contentType: 'image/svg+xml' }).window.document;
  assert.equal(document.querySelector('text').getAttribute('font-size'), '7.50');
  assert.equal(document.querySelector('text').textContent, '密集图表中的细节注释');
  assert.throws(() => validateScene({ ...input, elements: [{ ...input.elements[0], fontSize: 0 }] }));
});

test('high-resolution letter spacing is valid and scales with text to fit the source region', () => {
  const input = { width: 1850, height: 180, elements: [{ type: 'text', x: 0, y: 138, text: '伟大成就', fontSize: 140, letterSpacing: 45, maxWidth: 400 }] };
  const document = new JSDOM(sceneSVG(input), { contentType: 'image/svg+xml' }).window.document;
  const text = document.querySelector('text');
  assert.ok(Number(text.getAttribute('font-size')) < 140);
  assert.ok(Number(text.getAttribute('letter-spacing')) < 45);
  assert.ok(Number(text.getAttribute('letter-spacing')) > 0);
  assert.doesNotThrow(() => validateScene({ ...input, elements: [{ type: 'text', text: '旧版文字', fontSize: 8, letterSpacing: 12 }] }));
});
