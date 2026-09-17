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

// 城市名 → BOSS 城市代码（用户直接填城市名，无需查代码）
const CITY_MAP = {
  北京: '101010100', 上海: '101020100', 天津: '101030100', 重庆: '101040100',
  广州: '101280100', 深圳: '101280600', 东莞: '101281600', 佛山: '101281000',
  杭州: '101210100', 宁波: '101210400', 温州: '101210700',
  南京: '101190100', 苏州: '101190400', 无锡: '101190200', 常州: '101191100',
  武汉: '101200100', 西安: '101110100', 成都: '101270100',
  长沙: '101250100', 郑州: '101180100', 青岛: '101120200', 济南: '101120100',
  合肥: '101220100', 福州: '101230100', 厦门: '101230200',
  沈阳: '101070100', 大连: '101070200', 长春: '101060100', 哈尔滨: '101050100',
  石家庄: '101090100', 太原: '101100100', 南昌: '101240100', 贵阳: '101260100',
  昆明: '101290100', 南宁: '101300100'
};
const CITY_NAME_BY_CODE = Object.fromEntries(Object.entries(CITY_MAP).map(([k, v]) => [v, k]));
const CITY_ALL = '100010000'; // 全国

// 解析用户输入：城市名/带“市”后缀/直接填代码/留空=全国
function resolveCity(raw) {
  const t = String(raw || '').trim().replace(/市$/, '');
  if (!t) return CITY_ALL;
  if (/^\d{9}$/.test(t)) return t; // 直接填了代码，原样使用
  return CITY_MAP[t] || CITY_ALL;   // 未知城市名退回全国
}

function buildUrl(keyword, city) {
  return `https://www.zhipin.com/web/geek/jobs?city=${encodeURIComponent(city)}&query=${encodeURIComponent(keyword)}&page=1`;
}

$('startBtn').addEventListener('click', async () => {
  const target = Math.max(1, Math.min(1000, parseInt($('target').value, 10) || 100));
  const enrich = $('enrichCheck').checked;
  const concurrency = 1; // 已改为串行采集（一次一条最稳），保留字段兼容旧存储
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
    const cityInput = $('city').value.trim();
    const city = resolveCity(cityInput);
    const dailyCap = Math.max(0, parseInt($('dailyCap').value, 10) || 0);
    // 多关键词用逗号分隔（中英文逗号、顿号均可）时逐个接力；
    // 每个关键词严格忠于自身检索结果，不做变体扩展
    const keywords = raw.split(/[,，、]+/).map((x) => x.trim()).filter(Boolean);
    if (!keywords.length) keywords.push('RPA');
    await chrome.storage.local.set({ [SETTINGS_KEY]: { keyword: raw, city, cityName: cityInput, target, dailyCap } });
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
  type: 'START_ENRICH_CMD'
}));
$('sanitizeBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SANITIZE' }));
$('clearBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CLEAR' }));
$('logBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('log.html') }));

(async () => {
  const d = await chrome.storage.local.get(SETTINGS_KEY);
  const s = d[SETTINGS_KEY] || {};
  $('keyword').value = s.keyword || 'RPA';
  // 兼容旧数据：存的是代码则反查城市名显示
  $('city').value = s.cityName || CITY_NAME_BY_CODE[s.city] || (s.city === CITY_ALL ? '' : s.city) || '广州';
  $('target').value = s.target || 100;
  $('dailyCap').value = s.dailyCap != null ? s.dailyCap : 300;
  // 并发选择器已移除（串行采集）
  refresh();
  setInterval(refresh, 800);
})();
