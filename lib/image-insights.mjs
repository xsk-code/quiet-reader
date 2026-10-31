import { validateScene } from './image-scene.mjs';
export { validateScene, sceneSVG } from './image-scene.mjs';
const kinds = ['text', 'table', 'flowchart', 'chart', 'photo', 'other'];

function text(value, limit, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error('图片解读的文字无效或过长。');
  return value.trim();
}

/** Keep only bounded data fields; model output never supplies markup or file paths. */
export function validateInsight(value) {
  if (!value || typeof value !== 'object' || !kinds.includes(value.kind)) throw new Error('图片模型没有返回有效的解读类型。');
  const insight = {
    kind: value.kind, summary: text(value.summary, 4000, true),
    originalText: text(value.originalText, 12000), translatedText: text(value.translatedText, 12000),
    uncertainties: [],
  };
  if (value.scene !== undefined && value.scene !== null) insight.scene = validateScene(value.scene);
  if (value.uncertainties !== undefined) {
    if (!Array.isArray(value.uncertainties) || value.uncertainties.length > 10) throw new Error('图片解读的不确定项无效。');
    insight.uncertainties = value.uncertainties.map(item => text(item, 500, true));
  }
  if (value.table !== undefined && value.table !== null) {
    const { headers, rows } = value.table;
    if (value.kind !== 'table' || !Array.isArray(headers) || !headers.length || headers.length > 12
      || !Array.isArray(rows) || rows.length > 30) throw new Error('图片表格结构无效。');
    insight.table = { headers: headers.map(cell => text(cell, 200, true)), rows: rows.map(row => {
      if (!Array.isArray(row) || row.length !== headers.length) throw new Error('图片表格列数不一致。');
      return row.map(cell => text(cell, 500));
    }) };
  }
  if (value.diagram !== undefined && value.diagram !== null) {
    const { nodes, edges } = value.diagram;
    if (value.kind !== 'flowchart' || !Array.isArray(nodes) || !nodes.length || nodes.length > 12
      || !Array.isArray(edges) || edges.length > 24) throw new Error('图片流程图结构无效。');
    const ids = new Set();
    const diagram = { nodes: nodes.map(node => {
      if (!node || typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(node.id) || ids.has(node.id)) throw new Error('流程图节点无效或重复。');
      ids.add(node.id);
      return { id: node.id, label: text(node.label, 80, true) };
    }), edges: edges.map(edge => {
      if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) throw new Error('流程图连线无效。');
      return { from: edge.from, to: edge.to, label: text(edge.label, 40) };
    }) };
    insight.diagram = diagram;
  }
  return insight;
}

const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const markdownText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]#!|~]/g, '\\$&');

export function flowchartSVG(value) {
  const insight = validateInsight(value);
  if (!insight.diagram) return '';
  const { nodes, edges } = insight.diagram;
  const labelRows = (label, width) => {
    const parts = Array.from(label), rows = [];
    while (parts.length) rows.push(parts.splice(0, width).join(''));
    return rows;
  };
  const textLabel = (label, x, y, width = 16) => {
    const rows = labelRows(label, width);
    return `<text x="${x}" y="${y - (rows.length - 1) * 8}" fill="currentColor" stroke="none" text-anchor="middle" font-family="serif" font-size="15">${rows.map((row, j) => `<tspan x="${x}" dy="${j ? 17 : 0}">${xml(row)}</tspan>`).join('')}</text>`;
  };
  const labels = new Map(nodes.map(node => [node.id, node.label]));
  const description = edges.map(edge => `${labels.get(edge.from)} → ${labels.get(edge.to)}${edge.label ? '：' + edge.label : ''}`).join('；');
  const wrap = (body, width, height) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml('图片流程关系简图：' + (description || nodes[0].label))}"><title>图片流程关系简图 · AI 解读，布局经过简化</title><g fill="none" stroke="currentColor" stroke-width="1.2">${body}</g></svg>`;
  const outgoing = new Map(), incoming = new Set();
  let pathsOnly = true;
  for (const edge of edges) {
    if (outgoing.has(edge.from) || incoming.has(edge.to)) pathsOnly = false;
    outgoing.set(edge.from, edge); incoming.add(edge.to);
  }
  const groups = [], visited = new Set();
  if (pathsOnly) {
    for (const start of nodes.filter(node => !incoming.has(node.id))) {
      const group = [];
      let current = start;
      while (current && !visited.has(current.id)) {
        visited.add(current.id); group.push(current);
        current = nodes.find(node => node.id === outgoing.get(current.id)?.to);
      }
      groups.push(group);
    }
  }
  if (pathsOnly && visited.size === nodes.length && groups.every(group => group.length <= 4)) {
    const boxHeight = Math.max(70, ...nodes.map(node => labelRows(node.label, 11).length * 17 + 24));
    const rowHeight = boxHeight + 110;
    const body = groups.map((group, row) => {
      const top = row * rowHeight + 20, center = top + boxHeight / 2;
      const boxes = group.map((node, i) => `<rect x="${i * 230 + 10}" y="${top}" width="180" height="${boxHeight}" rx="3" fill="var(--paper, #f3f2ee)"/>${textLabel(node.label, i * 230 + 100, center + 5, 11)}`).join('');
      const arrows = group.slice(0, -1).map((node, i) => {
        const x = i * 230 + 190, end = x + 50, edge = outgoing.get(node.id);
        return `<path d="M${x} ${center} H${end}"/><path d="M${end - 6} ${center - 4} L${end} ${center} L${end - 6} ${center + 4}"/>${edge.label ? textLabel(edge.label, x + 25, top + boxHeight + 35, 12) : ''}`;
      }).join('');
      return boxes + arrows;
    }).join('');
    return wrap(body, Math.max(...groups.map(group => group.length)) * 230 - 30, groups.length * rowHeight);
  }
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const lines = edges.map((edge, i) => {
    const from = index.get(edge.from), to = index.get(edge.to);
    const start = from * 140 + 65, end = to * 140 + 65, lane = 360 + (i % 4) * 20;
    return `<path d="M330 ${start} H${lane} V${end} H334"/><path d="M340 ${end - 4} L334 ${end} L340 ${end + 4}"/>${edge.label ? textLabel(edge.label, 520, (start + end) / 2, 12) : ''}`;
  }).join('');
  const boxes = nodes.map((node, i) => `<rect x="20" y="${i * 140 + 20}" width="310" height="90" rx="3" fill="var(--paper, #f3f2ee)"/>${textLabel(node.label, 175, i * 140 + 65)}`).join('');
  return wrap(lines + boxes, 650, nodes.length * 140 + 20);
}

export function imageInsightsMarkdown(items = []) {
  const sections = [];
  for (const item of items) {
    if (item.status !== 'done' || !item.insight) continue;
    let insight;
    try { insight = validateInsight(item.insight); } catch { continue; }
    const parts = [`### 图片 ${sections.length + 1} 解读 · AI 生成`, markdownText(insight.summary)];
    if (insight.translatedText) parts.push(`**图片文字译文**\n\n${markdownText(insight.translatedText)}`);
    if (insight.table) parts.push([
      `| ${insight.table.headers.map(cell => markdownText(cell).replace(/\n/g, ' ')).join(' | ')} |`,
      `| ${insight.table.headers.map(() => '---').join(' | ')} |`,
      ...insight.table.rows.map(row => `| ${row.map(cell => markdownText(cell).replace(/\n/g, ' ')).join(' | ')} |`),
    ].join('\n'));
    if (insight.diagram) {
      const labels = new Map(insight.diagram.nodes.map(node => [node.id, node.label]));
      parts.push('**流程关系（简化）**\n\n' + insight.diagram.nodes.map(node => `- ${markdownText(node.label)}`).join('\n'));
      parts.push(insight.diagram.edges.map(edge => `- ${markdownText(labels.get(edge.from))} → ${markdownText(labels.get(edge.to))}${edge.label ? `：${markdownText(edge.label)}` : ''}`).join('\n'));
    }
    if (insight.uncertainties.length) parts.push('**无法确认**\n\n' + insight.uncertainties.map(value => `- ${markdownText(value)}`).join('\n'));
    if (insight.originalText) parts.push(`**图片原文**\n\n${markdownText(insight.originalText)}`);
    parts.push(`原图地址：${markdownText(item.source)}`);
    sections.push(parts.filter(Boolean).join('\n\n'));
  }
  return sections.length ? '\n\n---\n\n## 图片解读 · AI 生成\n\n' + sections.join('\n\n') : '';
}
