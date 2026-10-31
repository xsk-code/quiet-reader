import { handoffURL, readerJobURL, readerPendingURL, READER_ORIGIN, READER_ORIGINS } from './lib.mjs';

const DEFAULT_TITLE = '用拾页阅读这一页';
const MENU_PAGE = 'shiye-import-page';
const MENU_LINK = 'shiye-import-link';
const READER_TABS = READER_ORIGINS.map(origin => `${origin}/*`);
let busy = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#7b2d26' });
  chrome.action.setTitle({ title: DEFAULT_TITLE });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_PAGE, title: '用拾页阅读这一页', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_LINK, title: '用拾页阅读这个链接', contexts: ['link'] });
  });
});

chrome.action.onClicked.addListener(tab => { handoff(tab?.url); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handoff(info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl || tab?.url);
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'import-current-tab') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  handoff(tab?.url);
});

async function mark(text, title) {
  await chrome.action.setBadgeBackgroundColor({ color: '#7b2d26' });
  await chrome.action.setBadgeText({ text });
  if (title) await chrome.action.setTitle({ title });
}

async function openReader(url) {
  const tabs = await chrome.tabs.query({ url: READER_TABS });
  const tab = tabs.find(item => item.id !== undefined);
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    // Focusing is cosmetic: a closed or minimised window must not lose the job.
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url });
}

async function handoff(candidate) {
  if (busy) return;
  const url = handoffURL(candidate);
  if (!url) { await mark('!', '这个页面不能导入'); return; }
  busy = true;
  await mark('…', '正在交给拾页…');
  try {
    // The server accepts this origin only for POST /api/import. Only the URL is
    // sent: page text, cookies and the logged-in session stay in the browser.
    const response = await fetch(`${READER_ORIGIN}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(8_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const target = readerJobURL(result.id);
    if (!target) throw new Error('任务编号无效');
    await openReader(target);
    await mark('', DEFAULT_TITLE);
  } catch {
    // Keep the address: /?pending= prefills the reader so the URL survives a
    // stopped service, an unconfigured model or a blocked request.
    await openReader(readerPendingURL(url));
    await mark('!', '未能直接导入，请确认拾页已启动');
  } finally {
    busy = false;
  }
}
