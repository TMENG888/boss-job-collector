/** 当日运行日志查看页：级别筛选 / 关键字搜索 / 自动刷新 / 复制 / 下载 / 清空 */
const LOG_KEY = 'boss_log';
const $ = (id) => document.getElementById(id);
let filterLv = 'ALL';
let query = '';

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function render() {
  const d = await chrome.storage.local.get(LOG_KEY);
  const log = d[LOG_KEY] || { date: todayStr(), lines: [] };
  const all = Array.isArray(log.lines) ? log.lines : [];
  const shown = all.filter((l) => {
    if (filterLv !== 'ALL' && !l.includes(`[${filterLv}]`)) return false;
    if (query && !l.toLowerCase().includes(query)) return false;
    return true;
  });
  const counts = { WARN: 0, ERROR: 0 };
  for (const l of all) {
    if (l.includes('[WARN]')) counts.WARN++;
    else if (l.includes('[ERROR]')) counts.ERROR++;
  }
  $('stat').innerHTML =
    `${log.date} · 共 ${all.length} 条 · <span class="warn">警告 ${counts.WARN}</span> / <span class="err">错误 ${counts.ERROR}</span>`;
  $('log').innerHTML = shown.length
    ? shown.map((l) => `<div class="line ${lvOf(l)}">${esc(l)}</div>`).join('')
    : '<div class="empty">暂无匹配日志</div>';
  if (autoScrolled) window.scrollTo(0, document.body.scrollHeight);
}

function lvOf(line) {
  const m = line.match(/\[(INFO|OK|WARN|ERROR|ACTION|SYS)\]/);
  return m ? m[1] : 'INFO';
}

// 底部跟随：仅当用户本来就接近底部时才自动滚动
let autoScrolled = true;
window.addEventListener('scroll', () => {
  autoScrolled = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
    chip.classList.add('on');
    filterLv = chip.dataset.lv;
    render();
  });
});
$('q').addEventListener('input', () => {
  query = $('q').value.trim().toLowerCase();
  render();
});
$('copyBtn').addEventListener('click', async () => {
  const d = await chrome.storage.local.get(LOG_KEY);
  const lines = (d[LOG_KEY] && d[LOG_KEY].lines) || [];
  await navigator.clipboard.writeText(lines.join('\n'));
  $('copyBtn').textContent = '已复制✓';
  setTimeout(() => ($('copyBtn').textContent = '复制'), 1200);
});
$('dlBtn').addEventListener('click', async () => {
  const d = await chrome.storage.local.get(LOG_KEY);
  const lines = (d[LOG_KEY] && d[LOG_KEY].lines) || [];
  const blob = new Blob(['BOSS采集助手运行日志 ' + todayStr() + '\n' + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `boss采集日志_${todayStr()}.txt`, saveAs: true }, () => setTimeout(() => URL.revokeObjectURL(url), 60000));
});
$('clearBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ [LOG_KEY]: { date: todayStr(), lines: [] } });
  render();
});

render();
setInterval(() => { if ($('auto').checked) render(); }, 2000);
