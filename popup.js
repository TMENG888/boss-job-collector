/** BOSS岗位采集助手 —— 弹窗逻辑 */
const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'boss_settings';

const HEADERS = [
  '序号', '岗位名称', '薪资', '城市/区域', '经验要求', '学历要求', '技能标签', '福利标签',
  '公司名称', '所属行业', '公司规模', '融资阶段',
  'JD职位描述', '职位链接', '采集时间'
];

function setStatus(kind, text) {
  const el = $('status');
  el.textContent = text || kind;
  el.style.color =
    kind === 'ERROR' ? '#e33e2b' :
    kind === 'DONE' ? '#0a9c60' :
    kind === 'WARN' ? '#c78a2b' :
    kind === 'ENRICH' || kind === 'SWITCH' ? '#3b82f6' : '#8a919f';
}

function csvCell(v, maxLen = 30000) {
  v = v == null ? '' : String(v);
  if (v.length > maxLen) v = v.slice(0, maxLen) + '…';
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

async function exportCSV() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const jobs = (resp && resp.jobs) || [];
  if (!jobs.length) {
    setStatus('WARN', '暂无数据可导出，请先采集');
    return;
  }
  const rows = [HEADERS.join(',')];
  jobs.forEach((j, i) => {
    rows.push([
      i + 1, j.name, j.salary, j.area, j.experience, j.education, j.skills, j.welfare,
      j.company, j.industry, j.scale, j.funding,
      j.jd, j.link,
      j.collectedAt ? new Date(j.collectedAt).toLocaleString('zh-CN') : ''
    ].map((v) => csvCell(v)).join(','));
  });
  const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  chrome.downloads.download(
    { url, filename: `boss岗位_${stamp}.csv`, saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 60000)
  );
}

async function refresh() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!resp) return;
    $('count').textContent = resp.count;
    $('targetShow').textContent = resp.target;
    const pct = resp.target ? Math.min(100, (resp.count / resp.target) * 100) : 0;
    $('barFill').style.width = pct + '%';
    setStatus(resp.status, resp.message);
    $('startBtn').disabled = !!resp.running;
  } catch (e) { /* ignore */ }
}

function buildUrl(keyword, city) {
  return `https://www.zhipin.com/web/geek/jobs?city=${encodeURIComponent(city)}&query=${encodeURIComponent(keyword)}&page=1`;
}

$('startBtn').addEventListener('click', async () => {
  const target = Math.max(1, Math.min(1000, parseInt($('target').value, 10) || 100));
  const enrich = $('enrichCheck').checked;
  const concurrency = Math.max(1, Math.min(6, parseInt($('concurrency').value, 10) || 1));
  // 并发数两种模式都即时保存
  const d0 = await chrome.storage.local.get(SETTINGS_KEY);
  await chrome.storage.local.set({ [SETTINGS_KEY]: Object.assign({}, d0[SETTINGS_KEY], { concurrency }) });
  let urls;
  if ($('useCurrent').checked) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https:\/\/www\.zhipin\.com/.test(tab.url)) {
      setStatus('ERROR', '当前标签页不是 BOSS 直聘页面');
      return;
    }
    urls = [tab.url];
  } else {
    const raw = $('keyword').value.trim() || 'RPA';
    const city = $('city').value.trim() || '101280100';
    // 多关键词用逗号分隔时逐个接力；每个关键词严格忠于自身检索结果，不做变体扩展
    const keywords = raw.split(/[,，、]+/).map((x) => x.trim()).filter(Boolean);
    if (!keywords.length) keywords.push('RPA');
    await chrome.storage.local.set({ [SETTINGS_KEY]: { keyword: raw, city, target } });
    const seen = new Set();
    urls = [];
    for (const kw of keywords) {
      const u = buildUrl(kw, city);
      if (!seen.has(u)) { seen.add(u); urls.push(u); }
    }
  }
  setStatus('RUN', `正在启动（共 ${urls.length} 个搜索词）…`);
  chrome.runtime.sendMessage({ type: 'START', urls, url: urls[0], target, enrich, concurrency });
});

$('stopBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'STOP' }));
$('exportBtn').addEventListener('click', exportCSV);
$('jdBtn').addEventListener('click', () => chrome.runtime.sendMessage({
  type: 'START_ENRICH_CMD',
  concurrency: Math.max(1, Math.min(6, parseInt($('concurrency').value, 10) || 1))
}));
$('sanitizeBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SANITIZE' }));
$('clearBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CLEAR' }));

(async () => {
  const d = await chrome.storage.local.get(SETTINGS_KEY);
  const s = d[SETTINGS_KEY] || {};
  $('keyword').value = s.keyword || 'RPA';
  $('city').value = s.city || '101280100';
  $('target').value = s.target || 100;
  $('concurrency').value = s.concurrency || 1;
  refresh();
  setInterval(refresh, 800);
})();
