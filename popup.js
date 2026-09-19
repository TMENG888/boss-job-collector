/** 岗位采集助手 —— 弹窗逻辑（v2.0.0 双平台：BOSS直聘 / 实习僧） */
const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'boss_settings';

const PLATFORMS = ['boss', 'sx'];
const PLAT_NAME = { boss: 'BOSS直聘', sx: '实习僧' };
let curPlatform = 'boss';

const HEADERS = [
  '序号', '平台', '岗位名称', '薪资', '城市/区域', '经验要求', '学历要求', '技能标签', '福利标签',
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
  const jobs = (resp && resp[curPlatform] && resp[curPlatform].jobs) || [];
  if (!jobs.length) {
    setStatus('WARN', `暂无${PLAT_NAME[curPlatform]}数据可导出，请先采集`);
    return;
  }
  const rows = [HEADERS.join(',')];
  jobs.forEach((j, i) => {
    rows.push([
      i + 1, PLAT_NAME[curPlatform], j.name, j.salary, j.area, j.experience, j.education, j.skills, j.welfare,
      j.company, j.industry, j.scale, j.funding,
      j.jd, j.link,
      j.collectedAt ? new Date(j.collectedAt).toLocaleString('zh-CN') : ''
    ].map((v) => csvCell(v)).join(','));
  });
  const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  chrome.downloads.download(
    { url, filename: `岗位采集_${PLAT_NAME[curPlatform]}_${stamp}.csv`, saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 60000)
  );
}

async function refresh() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!resp) return;
    // Tab 角标：两平台各自条数
    $('cntBoss').textContent = (resp.boss && resp.boss.count) || 0;
    $('cntSx').textContent = (resp.sx && resp.sx.count) || 0;
    const cur = resp[curPlatform] || {};
    $('count').textContent = cur.count || 0;
    $('targetShow').textContent = cur.target || 0;
    const pct = cur.target ? Math.min(100, ((cur.count || 0) / cur.target) * 100) : 0;
    $('barFill').style.width = pct + '%';
    setStatus(cur.status, cur.message);
    $('startBtn').disabled = !!cur.running;
  } catch (e) { /* ignore */ }
}

/* ================= 平台切换 ================= */
function applyPlatformUI() {
  $('tabBoss').classList.toggle('active', curPlatform === 'boss');
  $('tabSx').classList.toggle('active', curPlatform === 'sx');
  if (curPlatform === 'boss') {
    $('kwLabel').textContent = '岗位关键词（多个用逗号分隔，采完一个自动接力下一个）';
    $('cityLabel').textContent = '城市（留空=全国）';
    $('city').placeholder = '如：广州';
    $('useCurrentLabel').textContent = '采集当前已打开的搜索页（忽略上方设置）';
  } else {
    $('kwLabel').textContent = '岗位关键词（多个用逗号分隔，采完一个自动接力下一个）';
    $('cityLabel').textContent = '城市（填城市名，留空=全国）';
    $('city').placeholder = '如：武汉 / 全国';
    $('useCurrentLabel').textContent = '采集当前已打开的实习僧搜索页（忽略上方设置）';
  }
  loadPlatformSettings();
}

$('tabBoss').addEventListener('click', () => { curPlatform = 'boss'; applyPlatformUI(); });
$('tabSx').addEventListener('click', () => { curPlatform = 'sx'; applyPlatformUI(); });

// 每平台独立的关键词/城市/目标设置（boss_settings.platforms[p]）
async function loadPlatformSettings() {
  const d = await chrome.storage.local.get(SETTINGS_KEY);
  const s = (d[SETTINGS_KEY] && d[SETTINGS_KEY].platforms && d[SETTINGS_KEY].platforms[curPlatform]) || {};
  $('keyword').value = s.keyword || (curPlatform === 'boss' ? 'RPA' : '智能体开发');
  $('city').value = s.cityName || (curPlatform === 'boss'
    ? (CITY_NAME_BY_CODE[s.city] || (s.city === CITY_ALL ? '' : s.city) || '广州')
    : (s.cityName || ''));
  $('target').value = s.target || 100;
}

async function savePlatformSettings(fields) {
  const d = await chrome.storage.local.get(SETTINGS_KEY);
  const s = d[SETTINGS_KEY] || {};
  s.platforms = s.platforms || {};
  s.platforms[curPlatform] = Object.assign({}, s.platforms[curPlatform], fields);
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

/* ================= BOSS 城市代码 ================= */
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

// 解析用户输入：城市名/带"市"后缀/直接填代码/留空=全国
function resolveCity(raw) {
  const t = String(raw || '').trim().replace(/市$/, '');
  if (!t) return CITY_ALL;
  if (/^\d{9}$/.test(t)) return t; // 直接填了代码，原样使用
  return CITY_MAP[t] || CITY_ALL;   // 未知城市名退回全国
}

function buildBossUrl(keyword, city) {
  return `https://www.zhipin.com/web/geek/jobs?city=${encodeURIComponent(city)}&query=${encodeURIComponent(keyword)}&page=1`;
}

// 实习僧搜索 URL（与站内真实搜索参数一致，城市直接用中文名）
function buildSxUrl(keyword, city) {
  return `https://www.shixiseng.com/interns?page=1&type=intern&keyword=${encodeURIComponent(keyword)}&area=&months=&days=&degree=&official=&enterprise=&salary=-0&publishTime=&sortType=&city=${encodeURIComponent(city || '全国')}&internExtend=`;
}

$('startBtn').addEventListener('click', async () => {
  const target = Math.max(1, Math.min(1000, parseInt($('target').value, 10) || 100));
  const enrich = $('enrichCheck').checked;
  let urls;
  if ($('useCurrent').checked) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostOk = tab && tab.url && (
      curPlatform === 'boss' ? /^https:\/\/www\.zhipin\.com/.test(tab.url) : /^https:\/\/www\.shixiseng\.com/.test(tab.url)
    );
    if (!hostOk) {
      setStatus('ERROR', `当前标签页不是${PLAT_NAME[curPlatform]}页面`);
      return;
    }
    urls = [tab.url];
  } else {
    const raw = $('keyword').value.trim() || (curPlatform === 'boss' ? 'RPA' : '智能体开发');
    const cityInput = $('city').value.trim();
    // 多关键词用逗号分隔（中英文逗号、顿号均可）时逐个接力；
    // 每个关键词严格忠于自身检索结果，不做变体扩展
    const keywords = raw.split(/[,，、]+/).map((x) => x.trim()).filter(Boolean);
    if (!keywords.length) keywords.push(curPlatform === 'boss' ? 'RPA' : '智能体开发');
    await savePlatformSettings({ keyword: raw, cityName: cityInput, city: curPlatform === 'boss' ? resolveCity(cityInput) : cityInput, target });
    const seen = new Set();
    urls = [];
    for (const kw of keywords) {
      const u = curPlatform === 'boss' ? buildBossUrl(kw, resolveCity(cityInput)) : buildSxUrl(kw, cityInput || '全国');
      if (!seen.has(u)) { seen.add(u); urls.push(u); }
    }
  }
  setStatus('RUN', `正在启动（共 ${urls.length} 个搜索词）…`);
  chrome.runtime.sendMessage({ type: 'START', platform: curPlatform, urls, url: urls[0], target, enrich });
});

$('stopBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'STOP', platform: curPlatform }));
$('exportBtn').addEventListener('click', exportCSV);
$('jdBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'START_ENRICH_CMD', platform: curPlatform }));
$('sanitizeBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SANITIZE', platform: curPlatform }));
$('clearBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CLEAR', platform: curPlatform }));
$('logBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('log.html') }));

(async () => {
  const d = await chrome.storage.local.get(SETTINGS_KEY);
  const s = d[SETTINGS_KEY] || {};
  applyPlatformUI();
  refresh();
  setInterval(refresh, 800);
})();
