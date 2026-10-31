// Pure helpers for the handoff extension. Kept free of chrome.* so they can be
// unit-tested from Node without a browser.
export const READER_ORIGIN = 'http://127.0.0.1:4317';
export const READER_ORIGINS = [READER_ORIGIN, 'http://localhost:4317'];
export const JOB_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function handoffURL(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  if (url.username || url.password) return '';
  // Clicking the extension while already in the reader is not an article.
  if (READER_ORIGINS.includes(url.origin)) return '';
  return url.href;
}

export function readerJobURL(id) {
  const value = String(id ?? '');
  if (!JOB_PATTERN.test(value)) return '';
  return `${READER_ORIGIN}/?job=${encodeURIComponent(value)}`;
}

export function readerPendingURL(url) {
  return `${READER_ORIGIN}/?pending=${encodeURIComponent(url)}`;
}
