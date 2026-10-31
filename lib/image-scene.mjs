const escapeXML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

function number(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('重绘图的尺寸或位置无效。');
  return value;
}
function color(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(?:#[a-f\d]{3}(?:[a-f\d]{3})?|none)$/i.test(value)) throw new Error('重绘图只接受十六进制颜色。');
  return value;
}

/** A drawing consists of geometry and literal text, never model-authored SVG. */
export function validateScene(value) {
  if (!value || typeof value !== 'object') throw new Error('重绘图数据无效。');
  const width = number(value.width, null, 1, 4096), height = number(value.height, null, 1, 4096);
  if (width === null || height === null || !Array.isArray(value.elements) || !value.elements.length || value.elements.length > 350) throw new Error('重绘图尺寸或元素数量无效。');
  const sourceSize = value.sourceSize ? { width: number(value.sourceSize.width, width, 1, 100000), height: number(value.sourceSize.height, height, 1, 100000) } : { width, height };
  return { width, height, sourceSize, background: color(value.background, '#ffffff'), elements: value.elements.map(element => {
    if (!element || !['rect', 'ellipse', 'line', 'path', 'text'].includes(element.type)) throw new Error('不支持的重绘元素。');
    const result = { type: element.type, fill: color(element.fill, element.type === 'text' ? '#222222' : 'none'), stroke: color(element.stroke, 'none'),
      strokeWidth: number(element.strokeWidth, 1, 0, 20), opacity: number(element.opacity, 1, 0, 1) };
    if (element.type === 'path') {
      if (typeof element.d !== 'string' || element.d.length > 4000 || !/^[MmLlHhVvCcSsQqTtAaZz\d.,+\-\s]+$/.test(element.d)) throw new Error('重绘路径无效。');
      result.d = element.d;
    } else {
      result.x = number(element.x, 0, 0, width); result.y = number(element.y, 0, 0, height);
      if (element.type === 'line') {
        result.x2 = number(element.x2, result.x, 0, width); result.y2 = number(element.y2, result.y, 0, height);
      } else if (element.type !== 'text') {
        result.width = number(element.width, 0, 0, width); result.height = number(element.height, 0, 0, height);
        result.rx = number(element.rx, 0, 0, Math.min(width, height));
      }
    }
    if (element.type === 'line' || element.type === 'path') result.arrow = element.arrow === true;
    if (element.dash !== undefined) {
      if (!Array.isArray(element.dash) || !element.dash.length || element.dash.length > 8) throw new Error('虚线样式无效。');
      result.dash = element.dash.map(value => number(value, 0, 0.1, 100));
    }
    if (element.type === 'text') {
      if (typeof element.text !== 'string' || !element.text.trim() || element.text.length > 1500) throw new Error('重绘文字无效。');
      result.text = element.text;
      result.fontSize = number(element.fontSize, 24, 4, 200);
      result.fontWeight = [400, 500, 600, 700, 800].includes(element.fontWeight) ? element.fontWeight : 400;
      result.italic = element.italic === true;
      result.anchor = ['start', 'middle', 'end'].includes(element.anchor) ? element.anchor : 'start';
      result.lineHeight = number(element.lineHeight, 1.35, 0.8, 2);
      result.letterSpacing = number(element.letterSpacing, 0, Math.min(-2, -result.fontSize), Math.max(12, result.fontSize));
      result.maxWidth = number(element.maxWidth, width, 1, width);
    }
    return result;
  }) };
}

export function sceneSVG(value, description = '中文重绘图') {
  const scene = validateScene(value);
  const markers = [];
  const elements = scene.elements.map((element, i) => {
    const style = `fill="${element.fill}" stroke="${element.stroke}" stroke-width="${element.strokeWidth}" opacity="${element.opacity}"${element.dash ? ` stroke-dasharray="${element.dash.join(' ')}"` : ''}`;
    let arrow = '';
    if (element.arrow && element.stroke !== 'none') {
      markers.push(`<marker id="arrow-${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${element.stroke}"/></marker>`);
      arrow = ` marker-end="url(#arrow-${i})"`;
    }
    if (element.type === 'rect') return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="${element.rx}" ${style}/>`;
    if (element.type === 'ellipse') return `<ellipse cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${element.width / 2}" ry="${element.height / 2}" ${style}/>`;
    if (element.type === 'line') return `<line x1="${element.x}" y1="${element.y}" x2="${element.x2}" y2="${element.y2}" ${style}${arrow}/>`;
    if (element.type === 'path') return `<path d="${element.d}" ${style}${arrow}/>`;
    const lines = element.text.split('\n');
    const estimatedWidth = Math.max(...lines.map(line => [...line].reduce((sum, char) => sum + (/[\u0000-\u00ff]/.test(char) ? 0.55 : 1), 0) * element.fontSize + Math.max(0, [...line].length - 1) * element.letterSpacing));
    const size = Math.min(element.fontSize, element.fontSize * element.maxWidth / Math.max(1, estimatedWidth));
    const spacing = element.letterSpacing * size / element.fontSize;
    return `<text x="${element.x}" y="${element.y}" ${style} font-family="Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="${size.toFixed(2)}" font-weight="${element.fontWeight}" font-style="${element.italic ? 'italic' : 'normal'}" text-anchor="${element.anchor}" letter-spacing="${spacing.toFixed(2)}">${lines.map((line, index) => `<tspan x="${element.x}" dy="${index ? size * element.lineHeight : 0}">${escapeXML(line)}</tspan>`).join('')}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.sourceSize.width}" height="${scene.sourceSize.height}" viewBox="0 0 ${scene.width} ${scene.height}" preserveAspectRatio="none" role="img" aria-label="${escapeXML(description)}"><title>${escapeXML(description)}</title><defs>${markers.join('')}</defs><rect width="100%" height="100%" fill="${scene.background}"/>${elements}</svg>`;
}
