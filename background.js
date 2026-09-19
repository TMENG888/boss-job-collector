/**
 * 岗位采集助手 —— background service worker（v2.0.0 双平台）
 *
 * 支持两个平台同时各自运行一条完整任务链（互不干扰）：
 *  - boss：BOSS直聘（zhipin.com，无限滚动 SPA + 热标签页JD导航 + 薪资字体解密）
 *  - sx  ：实习僧（shixiseng.com，MPA 分页20条/页 + URL跳页翻页 + 详情页明文字段）
 *
 * 负责任务调度：
 *  - 打开/定位搜索页并通知 content script 开始采集
 *  - 接收增量数据，去重、汇总、控制总量（达到目标数量自动停止）
 *  - 目标达成后调度 JD 详情补全（逐条下发任务）
 *  - 状态持久化到 chrome.storage.local（tasks 按平台分桶）
 */
const STATE_KEY = 'boss_state';

/* ================= 平台元数据 ================= */
const PLATFORMS = ['boss', 'sx'];
const PLAT = {
  boss: {
    name: 'BOSS直聘',
    tabQuery: 'https://www.zhipin.com/*',
    ownUrlRe: /web\/geek\/jobs|job_detail/,
    detailRe: /job_detail\//,
    alarmEnrich: 'enrichTick_boss',
    alarmList: 'listTick_boss',
    homeUrl: 'https://www.zhipin.com/'
  },
  sx: {
    name: '实习僧',
    tabQuery: 'https://www.shixiseng.com/*',
    ownUrlRe: /\/interns|\/intern\//,
    detailRe: /\/intern\/inn_/,
    alarmEnrich: 'enrichTick_sx',
    alarmList: 'listTick_sx',
    homeUrl: 'https://www.shixiseng.com/'
  }
};

function defaultTask() {
  return {
    running: false,
    enrich: true,        // 是否在采集后自动补全 JD 详情
    target: 100,
    collected: [],
    startedAt: null,
    searchUrl: '',
    queue: [],           // 搜索词 URL 队列（突破单搜索词条数上限）
    queueIndex: 0,
    enrichScheduled: false,
    activeTabId: null,
    concurrency: 1,
    dailyCount: 0,       // 每日JD额度计数（按平台独立计）
    dailyDate: ''
  };
}

let state = {
  tasks: { boss: defaultTask(), sx: defaultTask() },
  status: {
    boss: { status: 'IDLE', message: '空闲' },
    sx: { status: 'IDLE', message: '空闲' }
  }
};
let status = state.status; // status[p] = {status, message}
let stateLoaded = false;

/* ---------- 运行时标志（不持久化；SW 重启后由任务状态重建） ---------- */
const RT = {};
function rt(p) {
  if (!RT[p]) {
    RT[p] = {
      enrichStop: false,
      tickBusy: false,
      blockedStreak: 0,
      pausedUntil: 0,          // 熔断：连续被风控拦截时暂停到该时间点
      slowFactor: 1,           // 风控自适应减速：每次被拦截×1.5（上限4），每15条顺利×0.9（下限1）
      jobsSinceBreak: 0,
      nextBreakAt: 5 + Math.floor(Math.random() * 5), // 每5~9条随机长休一次
      cleanJobs: 0,
      infraFailStreak: 0,
      listBusy: false,
      lastListCards: 0,
      listNoGrowth: 0,
      listCaptRounds: 0,
      listZeroRounds: 0
    };
  }
  return RT[p];
}

function T(p) {
  return state.tasks[p] || (state.tasks[p] = defaultTask());
}

/* ---------- 状态持久化（含 v1.x 单平台旧数据迁移） ---------- */
async function loadState() {
  try {
    const d = await chrome.storage.local.get(STATE_KEY);
    const saved = d[STATE_KEY];
    if (saved) {
      if (saved.tasks) {
        state.tasks = { boss: defaultTask(), sx: defaultTask() };
        for (const p of PLATFORMS) {
          if (saved.tasks[p]) state.tasks[p] = Object.assign(defaultTask(), saved.tasks[p]);
        }
      } else if (saved.collected) {
        // v1.x 旧版：全部数据归属 boss 平台
        const t = Object.assign(defaultTask(), saved);
        delete t.status;
        delete t.message;
        state.tasks.boss = t;
      }
      if (saved.status && saved.status.boss) state.status = saved.status;
    }
  } catch (e) { /* ignore */ }
  stateLoaded = true;
}
function saveState() {
  return chrome.storage.local.set({ [STATE_KEY]: state }).catch(() => {});
}

function setStatus(p, s, m) {
  status[p] = { status: s, message: m };
  if (stateLoaded) {
    state.status[p] = status[p];
    saveState();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 启动/恢复：逐平台检查并续跑闹钟链 ---------- */
(async () => {
  await loadState();
  const { bootstrapped } = await chrome.storage.session.get('bootstrapped');
  if (!bootstrapped) await chrome.storage.session.set({ bootstrapped: true });

  for (const p of PLATFORMS) {
    const t = T(p);
    const r = rt(p);
    // JD 补全链在任何 SW 唤醒时自动续跑（含浏览器重启后；纯本地恢复，安全）
    if (!t.running && t.enrichScheduled && t.collected.length) {
      // 仅当闹钟真的丢失（如浏览器重启会清空闹钟）才拉起。SW 正常唤醒时闹钟仍在，
      // 不重建——否则会覆盖拟人节奏的等待时长（长休/冷却被缩短，等于自废风控节奏）
      chrome.alarms.getAll((all) => {
        if (!all.some((a) => a.name === PLAT[p].alarmEnrich) && !r.tickBusy) {
          r.enrichStop = false;
          pushLog('SYS', `[${PLAT[p].name}] SW唤醒：闹钟丢失，自动续跑JD补全`);
          scheduleNextTick(p, 8000);
        }
      });
    }
    if (!t.running) continue;
    // 列表任务恢复：确认标签页存在，重建列表闹钟链
    let tabOk = false;
    try {
      await chrome.tabs.get(t.activeTabId);
      tabOk = true;
    } catch (e) { /* 标签页已丢失 */ }
    if (!tabOk) {
      try {
        const tab = await openSearchPage(t.searchUrl, p);
        t.activeTabId = tab.id;
        await saveState();
      } catch (e2) {
        t.running = false;
        await saveState();
        setStatus(p, 'STOPPED', '标签页已丢失，请重新开始采集');
        continue;
      }
    }
    setStatus(p, 'RUN', '检测到任务曾被中断，已自动恢复采集…');
    notifyTab(t.activeTabId, 'START', 1200, 30);
    r.enrichStop = false;
    scheduleNextListTick(p, 5000);
  }
})();

// 浏览器重启后，未完成的任务视为失效
chrome.runtime.onStartup.addListener(() => {
  loadState().then(() => {
    let changed = false;
    for (const p of PLATFORMS) {
      const t = T(p);
      if (t.running) {
        t.running = false;
        status[p] = { status: 'STOPPED', message: '浏览器重启，任务已中断' };
        changed = true;
      }
    }
    if (changed) return saveState();
  });
});

/* ---------- 当日运行日志 ---------- */
// 仅保留当天的环形日志（跨天自动清空，上限3000行），供 log.html 页面查看与排错
const LOG_KEY = 'boss_log';
let logCache = { date: '', lines: [] };
let logTouched = false;
let logSaveTimer = null;

async function loadLog() {
  try {
    const d = await chrome.storage.local.get(LOG_KEY);
    if (!logTouched) logCache = d[LOG_KEY] || logCache;
  } catch (e) { /* ignore */ }
}
loadLog();

function pushLog(level, msg) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
  if (logCache.date !== today) logCache = { date: today, lines: [] }; // 跨天：仅保留当天
  const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  logCache.lines.push(`[${ts}] [${level}] ${msg}`);
  if (logCache.lines.length > 3000) logCache.lines.splice(0, logCache.lines.length - 3000);
  logTouched = true;
  if (!logSaveTimer) {
    logSaveTimer = setTimeout(() => { // 合并写入，避免高频存储抖动
      logSaveTimer = null;
      chrome.storage.local.set({ [LOG_KEY]: logCache }).catch(() => {});
    }, 800);
  }
}

/* ---------- 工具 ---------- */
function snapshot() {
  const out = {};
  for (const p of PLATFORMS) {
    const t = T(p);
    out[p] = {
      running: t.running,
      target: t.target,
      count: t.collected.length,
      status: (status[p] && status[p].status) || 'IDLE',
      message: (status[p] && status[p].message) || '空闲',
      jobs: t.collected
    };
  }
  return out;
}

function linkKey(link) {
  try {
    const u = new URL(link, 'https://www.shixiseng.com');
    // 优先取路径中的稳定岗位ID。BOSS 的 securityId/lid 是每次搜索会话动态生成的，
    // 同一岗位在不同关键词下不同——此前把它当主键，导致同一岗位被当成多条记录反复采集
    const m =
      u.pathname.match(/job_detail\/([0-9a-zA-Z]+)\.html/i) ||
      u.pathname.match(/\/intern\/(inn_[0-9a-zA-Z]+)/i) ||
      u.pathname.match(/([0-9a-f]{16,})\.html/i);
    if (m) return m[1].toLowerCase();
    return u.searchParams.get('jobId') || u.searchParams.get('securityId') || u.pathname;
  } catch (e) {
    return link || '';
  }
}

function jobKey(j) {
  if (j.link) {
    const k = linkKey(j.link);
    if (k) return k;
  }
  return `${j.name}|${j.company}|${j.salary}`;
}

function pendingCount(p) {
  return T(p).collected.filter((j) => !j.detailFetched).length;
}

/* ---------- 详情页字段合并 ---------- */
const SCALE_RE = /(\d+\s*-\s*\d+人|少于\d+人|\d+人以上|\d+人以下)/;
const FUND_RE =
  /(不需要融资|未融资|天使轮|A轮|B轮|C轮|D轮|已上市|国企|央企|民营|合资|外资|事业单位|独角兽)/;

/* ---------- HR/时间字段校验（值与列名不匹配的防线） ---------- */
// 对单条记录做校验修复，返回是否有变更
function sanitizeJob(j) {
  let changed = false;
  const c0 = j.company;
  j.company = String(j.company || '').trim();
  if (c0 !== j.company) changed = true;
  return changed;
}

// 从详情页公司信息块（保留换行/空格分隔的 token）解析公司名/行业/规模/融资，只用于填充空字段
function parseCompanyRaw(raw, companyName) {
  if (!raw) return {};
  const BAD = /公司基本信息|查看更多|查看全部|展开|收起|举报|在招|融资轮次|人员规模|学历要求|截止日期|发布于/;
  const toks = String(raw)
    .split(/[\n\r·|｜,，、]+|\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !BAD.test(s));
  const out = { name: '', scale: '', funding: '', industry: '' };
  for (const t of toks) {
    if (SCALE_RE.test(t)) {
      if (!out.scale) out.scale = t;
      continue;
    }
    if (FUND_RE.test(t)) {
      if (!out.funding) out.funding = t;
      continue;
    }
    if (!out.name && /^[\u4e00-\u9fa5A-Za-z0-9（）()·\-&]{2,25}$/.test(t)) {
      out.name = t; // 公司名通常是第一个非标签 token
      continue;
    }
    if (out.name && !out.industry && /^[\u4e00-\u9fa5A-Za-z&]{2,15}$/.test(t) && t !== (companyName || '').trim()) {
      out.industry = t;
    }
  }
  return out;
}

// 薪资合并：详情页薪资优先（更新、已解密）；但若详情页解密不全（含□）而列表薪资完好，则保留列表薪资
function pickSalary(listSalary, detailSalary) {
  const ls = String(listSalary || '').trim();
  const ds = String(detailSalary || '').trim();
  if (!ds) return ls;
  if (!ls) return ds;
  if (ds.includes('□') && !ls.includes('□')) return ls;
  return ds;
}

function tellTabStop(p) {
  const t = T(p);
  if (t.activeTabId == null) return;
  try {
    chrome.tabs.sendMessage(t.activeTabId, { type: 'STOP' }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}

async function manualStop(p, reason) {
  const t = T(p);
  const r = rt(p);
  t.running = false;
  t.enrichScheduled = false;
  r.enrichStop = true; // 同步中断闹钟驱动的 JD 采集
  try { await chrome.alarms.clear(PLAT[p].alarmEnrich); } catch (e) { /* ignore */ }
  try { await chrome.alarms.clear(PLAT[p].alarmList); } catch (e) { /* ignore */ }
  pushLog('ACTION', `[${PLAT[p].name}] 手动停止：${reason}`);
  await saveState();
  setStatus(p, 'STOPPED', reason);
  tellTabStop(p); // 手动停止 = 该平台全部停止；缺 JD 可之后点"补全JD"
}

// 调度 JD 补全（带去重，避免多处触发重复调度）；闹钟驱动，不依赖内容脚本与前台
function scheduleEnrich(p) {
  const t = T(p);
  const r = rt(p);
  if (t.enrichScheduled) return;
  if (!t.enrich || pendingCount(p) === 0) return;
  t.enrichScheduled = true;
  r.enrichStop = false;
  saveState();
  setStatus(p, 'ENRICH', '开始补全JD详情（模拟真人点击进出详情页，可后台运行）…');
  pushLog('ACTION', `[${PLAT[p].name}] 调度JD补全（闹钟驱动，可后台）`);
  scheduleNextTick(p, 3000);
}

function openSearchPage(url, p) {
  return chrome.tabs.query({ url: PLAT[p].tabQuery }).then((tabs) => {
    const t = tabs.find((x) => x.url && PLAT[p].ownUrlRe.test(x.url));
    if (t) return chrome.tabs.update(t.id, { url, active: true });
    return chrome.tabs.create({ url, active: true });
  });
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(v);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish(true);
      })
      .catch(() => finish(false));
  });
}

function waitTabUrl(tabId, test, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(v);
    };
    const listener = (id, info, tab) => {
      if (id === tabId && test(info.url || (tab && tab.url) || '')) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (test(t.url)) finish(true);
      })
      .catch(() => finish(false));
  });
}

// —— JD 详情采集：后台驱动"热"标签页导航（最终架构）——
// 实测：BOSS 对每次程序化请求（fetch/iframe/新开冷标签页）都返回 JS 安检页；
// 只有用户已登录、有交互历史的"热"标签页做导航时，被动安检才会像手动点击一样自动通过。
// 因此详情采集复用搜索页标签页本身：导航进详情 → 提取 → 导航回列表，循环逐条进行。
// 实习僧详情页为普通 SSR 页面，同样走热标签页导航（行为最接近真人）。

async function tabTitle(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return t.title || '';
  } catch (e) {
    return '';
  }
}

// 标签页丢失恢复：优先复用同平台任意标签页，否则新开（不激活，后台进行）
async function recoverTab(p) {
  const t = T(p);
  try {
    const tabs = await chrome.tabs.query({ url: PLAT[p].tabQuery });
    if (tabs.length) {
      t.activeTabId = tabs[0].id;
      await saveState();
      pushLog('SYS', `[${PLAT[p].name}] 已切换到现有标签页 #${t.activeTabId} 恢复采集`);
      return t.activeTabId;
    }
  } catch (e) { /* ignore */ }
  const tab = await chrome.tabs.create({ url: t.searchUrl || PLAT[p].homeUrl, active: false });
  t.activeTabId = tab.id;
  await saveState();
  pushLog('SYS', `[${PLAT[p].name}] 已新开标签页 #${t.activeTabId} 恢复采集`);
  return t.activeTabId;
}

// 导航热标签页到详情页并提取（完成后负责导航回列表页恢复现场）
async function warmTabDetail(link, p) {
  const t = T(p);
  let tabId = t.activeTabId;
  if (tabId == null) return { jd: '', via: 'no-tab' };
  let listUrl = t.searchUrl;
  let winId = null;
  try {
    const tb = await chrome.tabs.get(tabId);
    winId = tb.windowId;
    if (!listUrl && tb.url && PLAT[p].ownUrlRe.test(tb.url)) listUrl = tb.url;
  } catch (e) { /* ignore */ }
  // 窗口被最小化时后台标签页会被强节流甚至冻结：无焦点恢复（不抢前台，用户无感）
  if (winId != null) {
    try {
      const win = await chrome.windows.get(winId);
      if (win.state === 'minimized') await chrome.windows.update(winId, { state: 'normal', focused: false });
    } catch (e) { /* ignore */ }
  }
  const t0 = Date.now();
  try {
    try {
      await chrome.tabs.update(tabId, { url: link });
    } catch (e) {
      // 标签页已丢失（被关闭/崩溃/被浏览器回收）：自动重建，否则整个队列会以
      // "导航失败"级联烧穿（每条3次重试全部白耗且被误标完成）
      const msg = String((e && e.message) || e);
      if (!/No tab with id|tab was closed|cannot be edited|Tabs cannot/i.test(msg)) throw e;
      pushLog('WARN', `[${PLAT[p].name}] 任务标签页已丢失（${msg.slice(0, 60)}），自动重建恢复采集`);
      tabId = await recoverTab(p);
      await chrome.tabs.update(tabId, { url: link });
    }
    // 等 URL 落位到详情页（最多25s）。BOSS 有安检链：security.html(JS算令牌)→重定向回详情
    let landed = await waitTabUrl(tabId, (u) => PLAT[p].detailRe.test(u || ''), 25000);
    if (!landed) {
      // 未落位：区分"IP封禁页(403)"与"滑块/验证页"。封禁页标题可能是正常站点名，
      // 只能读正文判断；封禁时继续等待/重试毫无意义，还会延长封禁
      let bodyText = '';
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => String((document.body && document.body.innerText) || '').slice(0, 300)
        });
        bodyText = (res && res[0] && res[0].result) || '';
      } catch (e) { /* ignore */ }
      if (/访问受限|暂时被禁止|异常行为|访问异常|请求过于频繁/.test(bodyText)) {
        return {
          jd: '', via: 'blocked', ms: Date.now() - t0,
          diag: { src: 'tab', title: await tabTitle(tabId), url: link, n: bodyText.length, text: 'IP/账号封禁页(访问受限)：等待解除，请勿频繁重试' }
        };
      }
      const title = await tabTitle(tabId);
      if (/安全验证|验证码|请稍候|security/i.test(title)) {
        setStatus(p, 'WARN', '页面出现安全验证，请在当前标签页手动完成（滑块/点选），完成后自动继续…');
        landed = await waitTabUrl(tabId, (u) => PLAT[p].detailRe.test(u || ''), 120000);
      }
    }
    if (!landed) {
      return {
        jd: '', via: 'blocked', ms: Date.now() - t0,
        diag: { src: 'tab', title: await tabTitle(tabId), url: link, n: 0, text: '安检未通过（未落到详情页）' }
      };
    }
    await waitTabComplete(tabId, 15000);
    // 模拟真人阅读JD：在详情页停留片刻再返回列表（停留过短本身就是机器人特征）
    await sleep(1500 + Math.random() * 3000);
    // 先探测内容脚本已注入（最多6×1s），再提取；避免把"未注入"误判成"提取为空"
    let injected = false;
    for (let i = 0; i < 6; i++) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        injected = true;
        break;
      } catch (e) { await sleep(1000); }
    }
    if (!injected) {
      // 自动注入失败（扩展重载后的孤儿页/注入时序问题）：用 scripting API 手动注入再试
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        await sleep(800);
        await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        injected = true;
      } catch (e) { /* 注入也失败，走"未注入"诊断分支 */ }
    }
    let resp = null;
    if (injected) {
      // 页面内脚本等水合（最多8s）后提取；未取到则重试下发
      for (let i = 0; i < 4; i++) {
        try {
          resp = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_DETAIL' });
          if (resp && resp.detail && resp.detail.jd) break;
        } catch (e) { /* 消息失败，稍后重试 */ }
        await sleep(1500);
      }
    }
    const d = (resp && resp.detail) || {
      jd: '', via: 'tab',
      diag: {
        src: 'tab', title: injected ? '内容脚本已响应但无结果' : '内容脚本未注入/未响应',
        url: link, n: 0, text: injected ? '多次提取均未返回JD' : '详情页已加载但消息未送达（检查扩展是否刚重载过，请刷新页面后重试）'
      }
    };
    d.ms = Date.now() - t0;
    return d;
  } catch (e) {
    return {
      jd: '', via: 'fail', ms: Date.now() - t0,
      diag: { src: 'tab', title: '导航失败', url: link, n: 0, text: String((e && e.message) || e).slice(0, 120) }
    };
  } finally {
    if (listUrl) {
      try { await chrome.tabs.update(tabId, { url: listUrl }); } catch (e) { /* ignore */ }
      await waitTabComplete(tabId, 15000);
    }
  }
}

// 详情字段合并（enrichTick 闹钟步与 JD_RESULT 消息共用）；同键孪生记录一并标记
function applyDetail(p, key, d) {
  const list = T(p).collected.filter((x) => jobKey(x) === key);
  if (!list.length) return null;
  d = d || {};
  for (const j of list) {
    j.jd = d.jd || '';
    j.welfare = d.welfare || j.welfare || '';
    j.salary = pickSalary(j.salary, d.salary); // 详情页薪资优先（实习僧为明文）；解密不全则保留列表薪资
    // 实习僧列表页岗位名中的公司名部分是加密字形（解不出则□占位）：详情页为明文，直接修复
    if (d.name && (!j.name || j.name.includes('□'))) j.name = d.name;
    j.education = j.education || d.education || ''; // 实习僧详情页有明文学历
    j.experience = j.experience || d.experience || '';
    const comp = parseCompanyRaw(d.companyRaw, j.company);
    if (!j.company && comp.name) j.company = comp.name;
    j.industry = j.industry || comp.industry || '';
    j.scale = j.scale || comp.scale || '';
    j.funding = j.funding || comp.funding || '';
    j.area = j.area || d.area || '';
    sanitizeJob(j);
    j.detailVia = d.via || '';
    if (!d.jd && d.diag) j.detailDiag = d.diag; // 诊断：拿不到 JD 时记录页面指纹
    if (d.via === 'fail') {
      // 基础设施故障（标签页丢失/导航异常）：不消耗重试次数、不标记完成，
      // 待恢复后自动重试；否则会级联把整个队列烧成"完成但无JD"
      j.detailTries = Math.max(0, (j.detailTries || 1) - 1);
      j.detailFetching = false;
      continue;
    }
    j.detailTries = (j.detailTries || 0) + 1;
    // 只有真抓到 JD 才算完成（空结果重试，最多 3 次）；必清 detailFetching 防死循环
    if (d.jd || j.detailTries >= 3) j.detailFetched = true;
    j.detailFetching = false;
  }
  return list[0];
}

/* ================= 每日JD额度 ================= */
// 默认 300 条/天/平台，可在弹窗"每日JD上限"调整（0=不限制）。
// 注意：300 并非实测阈值，而是保守推断值——真实日志显示 BOSS 单日约1000条
// 本身未立刻封禁，但账号风险分疑似跨天累积（"多次违规"），额度用于控制累积速度。
// 两个平台各计各的（风控体系互相独立）
let dailyCap = 300;
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.boss_settings) {
      const v = changes.boss_settings.newValue && changes.boss_settings.newValue.dailyCap;
      dailyCap = v == null ? 300 : Math.max(0, parseInt(v, 10) || 0);
    }
  });
  chrome.storage.local.get('boss_settings').then((d) => {
    const v = d && d.boss_settings && d.boss_settings.dailyCap;
    if (v != null) dailyCap = Math.max(0, parseInt(v, 10) || 0);
  }).catch(() => {});
} catch (e) { /* ignore */ }

function scheduleNextTick(p, delayMs) {
  const r = rt(p);
  if (r.enrichStop) return;
  chrome.alarms.create(PLAT[p].alarmEnrich, { when: Date.now() + Math.max(1000, delayMs) });
}

// 拟人节奏：条间4~9s×减速因子；每5~9条插入30~90s长休（真人不会匀速刷几百条）。
// 以"下一次闹钟的延迟"表达——SW 可在等待中休眠，闹钟到点会唤醒它继续
function nextDelayMs(p) {
  const r = rt(p);
  r.jobsSinceBreak++;
  if (r.jobsSinceBreak >= r.nextBreakAt) {
    r.jobsSinceBreak = 0;
    r.nextBreakAt = 5 + Math.floor(Math.random() * 5);
    return 30000 + Math.random() * 60000;
  }
  return (4000 + Math.random() * 5000) * r.slowFactor;
}

async function enrichTick(p) {
  const t = T(p);
  const r = rt(p);
  if (r.tickBusy || r.enrichStop || !t.enrichScheduled) return;
  r.tickBusy = true;
  try {
    if (Date.now() < r.pausedUntil) {
      scheduleNextTick(p, r.pausedUntil - Date.now() + 1000); // 熔断冷却中，等解除
      return;
    }
    // 每日额度熔断：跨天自动重置；用完后休眠到次日08:00
    const today = new Date().toDateString();
    if (t.dailyDate !== today) {
      t.dailyDate = today;
      t.dailyCount = 0;
    }
    if (dailyCap > 0 && (t.dailyCount || 0) >= dailyCap) {
      const next = new Date();
      next.setHours(8, 0, 0, 0);
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
      setStatus(p, 'WARN', `已达今日JD额度（${dailyCap} 条），明早8点后自动继续（可在弹窗"每日JD上限"调整，0=不限）`);
      pushLog('WARN', `[${PLAT[p].name}] 今日JD额度已用完（${t.dailyCount}/${dailyCap}），休眠至次日08:00自动继续`);
      await saveState();
      scheduleNextTick(p, next.getTime() - Date.now() + 60000);
      return;
    }
    const now = Date.now();
    const retryable = (j) => j.detailFetching && now - (j.fetchStartedAt || 0) > 90000;
    const j = t.collected.find((x) => {
      if (x.detailFetched) return false;
      if (x.detailFetching && !retryable(x)) return false;
      // 同键孪生记录已采过：直接镜像完成，不重复抓取
      const k = jobKey(x);
      if (t.collected.some((y) => y !== x && jobKey(y) === k && y.detailFetched)) {
        x.detailFetched = true;
        return false;
      }
      return true;
    });
    if (!j) {
      // 全部处理完
      t.enrichScheduled = false;
      await saveState();
      const left = pendingCount(p);
      if (left > 0) {
        setStatus(p, 'WARN', `JD补全结束：还剩 ${left} 条未取到（多为反复拿不到的岗位），可稍后再点"补全JD"重试`);
      } else if (t.collected.length) {
        setStatus(p, 'DONE', `全部完成 ✔ 共 ${t.collected.length} 条（含JD详情），可点击"导出CSV"`);
      }
      return;
    }
    const key = jobKey(j);
    j.detailFetching = true;
    j.fetchStartedAt = Date.now();
    await saveState();
    setStatus(p, 'ENRICH', `JD详情 ${t.collected.indexOf(j) + 1}/${t.collected.length}：${j.name}`);
    const d = await warmTabDetail(j.link, p);
    applyDetail(p, key, d);
    await saveState(); // 立即持久化：SW 在步间休眠也不丢结果（此前丢失导致同一岗位反复重抓）
    // 连续基础设施故障熔断：重建标签页 + 暂停1分钟，避免 8s 间隔级联烧穿队列
    if (d.via === 'fail') {
      r.infraFailStreak++;
      if (r.infraFailStreak >= 3) {
        r.infraFailStreak = 0;
        await recoverTab(p);
        r.pausedUntil = Date.now() + 60000;
        setStatus(p, 'WARN', '标签页连续异常，已自动重建并暂停1分钟后继续…');
        pushLog('WARN', `[${PLAT[p].name}] 连续3次导航失败：已重建标签页，熔断1分钟`);
      }
    } else {
      r.infraFailStreak = 0;
    }
    const done = t.collected.length - pendingCount(p);
    const tag = d.jd
      ? ` · 上条 ${(d.ms / 1000).toFixed(1)}s · ${d.jdVia || ''}`
      : d.via === 'blocked'
        ? ' · ⚠风控拦截'
        : d.diag
          ? ` · ${d.diag.title || '无标题'}(${d.diag.n || '?'}字)${d.diag.text ? ' ' + String(d.diag.text).slice(0, 60) : ''}`
          : ' · 未取到JD，稍后重试';
    setStatus(p, 'ENRICH', `JD获取中：已完成 ${done}/${t.collected.length}（还剩 ${pendingCount(p)}）${tag}`);
    pushLog(d.jd ? 'OK' : 'WARN', `[${PLAT[p].name}] JD ${t.collected.indexOf(j) + 1}/${t.collected.length} ${d.jd ? '✓' + (d.jdVia || '') : '✗未取到'} · ${(d.ms / 1000).toFixed(1)}s · ${j.name}${d.diag ? ' · ' + (d.diag.title || '') + `(${d.diag.n || '?'}字)` : ''}`);

    // 计算下一步延迟（含风控应对与拟人节奏），以闹钟形式安排
    let delay = nextDelayMs(p);
    if (d.via === 'blocked') {
      r.blockedStreak++;
      r.slowFactor = Math.min(4, r.slowFactor * 1.5); // 被拦截立即整体减速
      if (r.blockedStreak === 1) {
        // 首次拦截就冷却：封禁期间继续请求只会延长封禁
        delay = 30000 + Math.random() * 30000;
        setStatus(p, 'WARN', '遇到风控拦截，冷却约1分钟后继续（已自动降低整体速度）…');
        pushLog('WARN', `[${PLAT[p].name}] 风控拦截：冷却${Math.round(delay / 1000)}s，整体减速×1.5=${r.slowFactor.toFixed(2)}`);
      }
      if (r.blockedStreak >= 3) {
        r.pausedUntil = Date.now() + 90000;
        setStatus(p, 'WARN', '连续遇到安全验证，暂停90秒后自动重试；若页面有滑块请手动完成');
        pushLog('WARN', `[${PLAT[p].name}] 连续3次拦截/安检失败：熔断暂停90秒`);
      }
    } else if (d.jd) {
      r.blockedStreak = 0;
      r.cleanJobs++;
      t.dailyCount = (t.dailyCount || 0) + 1; // 每日额度计数
      if (r.cleanJobs % 15 === 0) r.slowFactor = Math.max(1, r.slowFactor * 0.9); // 顺利时缓慢恢复速度
      r.pausedUntil = 0;
    }
    if (Date.now() < r.pausedUntil) delay = Math.max(delay, r.pausedUntil - Date.now());
    scheduleNextTick(p, delay);
  } catch (e) {
    // 链路自愈：任何单步异常都不允许中断闹钟链（此前跑到一半静默停的根因）
    setStatus(p, 'WARN', `单条处理异常已跳过：${String((e && e.message) || e).slice(0, 80)}（链路自动继续）`);
    pushLog('ERROR', `[${PLAT[p].name}] 单步异常跳过：${String((e && e.stack) || e).slice(0, 400)}`);
    if (t.enrichScheduled && !r.enrichStop) scheduleNextTick(p, 15000);
  } finally {
    r.tickBusy = false;
  }
}

/* ================= 列表采集：闹钟驱动的单步状态机（v1.5.0 起） =================
 * 与 enrichTick 同架构：每步向任务标签页发 LIST_STEP（一次拟人手势+抓取），
 * 依据返回决定下一步节奏。SW 随便休眠，闹钟到点唤醒继续。
 * 【实测依据】隐藏标签页中页面内自驱动循环被定时器节流到 ~1次/分、
 * scroll 事件永不触发（BOSS 懒加载器饿死）→ 假死停在首屏几十条；
 * 后台 Runtime 驱动的单步 + 页面内合成 scroll 派发实测可持续加载（30 手势/分）。
 * 实习僧为 SSR 分页列表（20条/页）：第一步即取全页，3 轮确认后 URL 跳页。
 */
function scheduleNextListTick(p, delayMs) {
  const t = T(p);
  const r = rt(p);
  if (r.enrichStop || !t.running) return;
  chrome.alarms.create(PLAT[p].alarmList, { when: Date.now() + Math.max(800, delayMs) });
}

// 带超时的单发消息；gone=标签页/脚本丢失，timeout=应答超时（脚本可能还在忙）
function sendToTabMsg(tabId, msg, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ timeout: true }); }
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve({ gone: true, error: chrome.runtime.lastError.message });
        else resolve(resp || { gone: true, error: 'empty response' });
      });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      resolve({ gone: true, error: String((e && e.message) || e) });
    }
  });
}

// 当前搜索词采尽：切换队列下一个 / 收尾补全。返回是否还有下一个
async function handleExhausted(p) {
  const t = T(p);
  const r = rt(p);
  if (t.running && t.queueIndex + 1 < (t.queue || []).length) {
    t.queueIndex++;
    t.searchUrl = t.queue[t.queueIndex];
    setStatus(p, 'SWITCH', `当前搜索词已采尽，自动切换下一搜索词（${t.queueIndex + 1}/${t.queue.length}）…`);
    pushLog('ACTION', `[${PLAT[p].name}] 搜索词采尽，接力切换 ${t.queueIndex + 1}/${t.queue.length}：${t.searchUrl}`);
    await saveState();
    try {
      await chrome.tabs.update(t.activeTabId, { url: t.searchUrl });
      notifyTab(t.activeTabId, 'START', 1000, 45); // 新页面注入后自动续采
    } catch (e) { /* ignore */ }
    scheduleNextListTick(p, 9000 + Math.random() * 6000); // 切词休息
    return true;
  }
  // 队列也空了：收尾并补全 JD
  t.running = false;
  const total = t.collected.length;
  const capNote = p === 'boss' ? '（BOSS 单搜索词上限约300条，可增加关键词扩大范围）' : '（实习僧单搜索词为分页列表，可增加关键词扩大范围）';
  setStatus(p, 'DONE', `全部搜索词采集完毕，共 ${total} 条${capNote}`);
  await saveState();
  scheduleEnrich(p);
  return false;
}

async function listTick(p) {
  const t = T(p);
  const r = rt(p);
  if (r.listBusy || r.enrichStop || !t.running || t.enrichScheduled) return;
  r.listBusy = true;
  try {
    if (Date.now() < r.pausedUntil) {
      scheduleNextListTick(p, r.pausedUntil - Date.now() + 1000);
      return;
    }
    if (t.activeTabId == null) {
      await recoverTab(p);
      scheduleNextListTick(p, 5000);
      return;
    }
    const resp = await sendToTabMsg(t.activeTabId, { type: 'LIST_STEP' });
    if (resp.timeout || resp.busy) {
      // 页面在忙（上一步还没返回）；过会再问，不算故障
      scheduleNextListTick(p, 3000 + Math.random() * 2000);
      return;
    }
    if (resp.gone || !resp.ok) {
      pushLog('WARN', `[${PLAT[p].name}] 列表步进失败：${String(resp.error || '标签页无响应').slice(0, 100)}，尝试恢复标签页`);
      await recoverTab(p);
      notifyTab(t.activeTabId, 'START', 1200, 30);
      scheduleNextListTick(p, 5000);
      return;
    }
    if (resp.exhausted) {
      // 跳页守卫判定采尽
      await handleExhausted(p);
      return;
    }
    if (resp.blocked) {
      t.running = false;
      r.enrichStop = true;
      await saveState();
      setStatus(p, 'ERROR', `IP 已被 ${PLAT[p].name} 限制访问（"访问受限"页）。已停止采集，已采数据可导出；待限制解除后再开始`);
      pushLog('ERROR', `[${PLAT[p].name}] 列表阶段检测到IP封禁页，任务停止`);
      return;
    }
    if (resp.captcha) {
      r.listCaptRounds++;
      if (r.listCaptRounds > 30) {
        t.running = false;
        r.enrichStop = true;
        await saveState();
        setStatus(p, 'ERROR', '安全验证等待超时（5分钟），已停止。完成后可重新开始');
        pushLog('ERROR', `[${PLAT[p].name}] 列表阶段安全验证等待超时，任务停止`);
        return;
      }
      setStatus(p, 'WAIT_CAPTCHA', '检测到安全验证，请在页面上手动完成（等待中，采到 ' + t.collected.length + ' 条）…');
      pushLog('WARN', `[${PLAT[p].name}] 列表阶段安全验证：等待人工完成（第 ${r.listCaptRounds}/30 轮）`);
      scheduleNextListTick(p, 10000);
      return;
    }
    r.listCaptRounds = 0;
    if (!resp.cards) {
      if (++r.listZeroRounds > 20) {
        t.running = false;
        r.enrichStop = true;
        await saveState();
        setStatus(p, 'ERROR', `未找到岗位列表：请确认已登录，且当前页面是${PLAT[p].name}的职位搜索结果页`);
        pushLog('ERROR', `[${PLAT[p].name}] 列表阶段连续无卡片，任务停止`);
        return;
      }
      // 首屏还没渲染：隔步重试，间隔逐渐放大（最长15s）
      scheduleNextListTick(p, Math.min(15000, 2500 + r.listZeroRounds * 1000 + Math.random() * 1500));
      return;
    }
    r.listZeroRounds = 0;
    // 底部无增长判定：间隔式多次确认，绝不因一两轮而误判
    if (resp.atBottom && resp.cards === r.lastListCards) r.listNoGrowth++;
    else r.listNoGrowth = 0;
    r.lastListCards = resp.cards;
    if (r.listNoGrowth >= 3) {
      r.listNoGrowth = 0;
      r.lastListCards = 0;
      const adv = await sendToTabMsg(t.activeTabId, { type: 'LIST_ADVANCE' }, 25000);
      const action = adv && adv.action;
      if (action === 'clicked' || action === 'jumped') {
        pushLog('ACTION', `[${PLAT[p].name}] ` + (action === 'jumped' ? '列表翻页：URL跳页' : '列表翻页：点击下一页'));
        scheduleNextListTick(p, 6000 + Math.random() * 7000); // 模拟人工翻页节奏
      } else {
        // 无按钮（SPA到底）或翻页原语不可用 → 本词真采尽
        await handleExhausted(p);
      }
      return;
    }
    // 节奏：普通 0.9~2.5s；到底等懒加载窗口 6~10s（三轮 ≈ 18~30s 耐心，与旧版对齐）；
    // 约3%长休 12~30s（风控拟人）
    let delay = resp.atBottom ? 6000 + Math.random() * 4000 : 900 + Math.random() * 1600;
    if (Math.random() < 0.03) {
      delay = 12000 + Math.random() * 18000;
      pushLog('SYS', `[${PLAT[p].name}] 模拟真人阅读长休 ` + Math.round(delay / 1000) + 's');
    }
    scheduleNextListTick(p, delay);
  } catch (e) {
    pushLog('ERROR', `[${PLAT[p].name}] 列表步进异常：` + String((e && e.stack) || e).slice(0, 400));
    if (t.running && !r.enrichStop) scheduleNextListTick(p, 4000); // 链路自愈
  } finally {
    r.listBusy = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  for (const p of PLATFORMS) {
    if (alarm.name === PLAT[p].alarmEnrich) { enrichTick(p); return; }
    if (alarm.name === PLAT[p].alarmList) { listTick(p); return; }
  }
  if (alarm.name === 'enrichHeartbeat') {
    // 心跳兜底：两条平台 × 两类闹钟链，任何一条断裂都每分钟检查重新拉起
    chrome.alarms.getAll((all) => {
      const has = (n) => all.some((a) => a.name === n);
      for (const p of PLATFORMS) {
        const t = T(p);
        const r = rt(p);
        if (r.tickBusy || r.listBusy || r.enrichStop) continue;
        if (t.enrichScheduled && !has(PLAT[p].alarmEnrich)) {
          pushLog('SYS', `[${PLAT[p].name}] 心跳检测到JD补全闹钟链断裂，已重新拉起`);
          scheduleNextTick(p, 2000);
        } else if (t.running && !t.enrichScheduled && !has(PLAT[p].alarmList)) {
          pushLog('SYS', `[${PLAT[p].name}] 心跳检测到列表采集闹钟丢失，已重新拉起`);
          scheduleNextListTick(p, 2000);
        }
      }
    });
  }
});
// 心跳闹钟常驻（每次唤醒都重建一次，同名幂等）
chrome.alarms.create('enrichHeartbeat', { periodInMinutes: 1, delayInMinutes: 1 });

// 带重试的消息下发（content script 可能尚未就绪）
function notifyTab(tabId, type, gapMs = 1200, maxTries = 40) {
  if (tabId == null) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (tries > maxTries) { clearInterval(timer); return; }
    try {
      chrome.tabs.sendMessage(tabId, { type }, () => {
        if (chrome.runtime.lastError) return; // 尚未就绪，稍后重试
        clearInterval(timer);
      });
    } catch (e) {
      clearInterval(timer);
    }
  }, gapMs);
}

async function tabExists(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- 消息路由 ---------- */
// 由 sender.tab 解析平台：优先按活动标签页匹配，其次按 URL 域名
function platformFromTab(sender) {
  const tab = sender && sender.tab;
  if (!tab) return null;
  for (const p of PLATFORMS) {
    if (T(p).activeTabId === tab.id) return p;
  }
  const u = String(tab.url || '');
  if (/shixiseng\.com/.test(u)) return 'sx';
  if (/zhipin\.com/.test(u)) return 'boss';
  return 'boss';
}
function validPlatform(p) {
  return PLATFORMS.includes(p) ? p : 'boss';
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'START': {
        const p = validPlatform(msg.platform);
        const t = T(p);
        const r = rt(p);
        r.enrichStop = true; // 若该平台旧采集在跑，立即停下（新调度启动时会重置）
        try { chrome.alarms.clear(PLAT[p].alarmEnrich); } catch (e) { /* ignore */ }
        try { chrome.alarms.clear(PLAT[p].alarmList); } catch (e) { /* ignore */ }
        t.target = msg.target || 100;
        t.enrich = msg.enrich !== false;
        t.collected = [];
        t.running = true;
        t.startedAt = Date.now();
        t.queue = (Array.isArray(msg.urls) && msg.urls.length ? msg.urls : [msg.url]).filter(Boolean);
        t.queueIndex = 0;
        t.searchUrl = t.queue[0] || '';
        t.enrichScheduled = false;
        t.concurrency = 1;
        setStatus(p, 'RUN', '正在打开/定位搜索页面…');
        pushLog('ACTION', `[${PLAT[p].name}] 开始采集：${(msg.urls && msg.urls.length) || 1} 个搜索词 · 目标 ${t.target} · 自动JD=${t.enrich}`);
        await saveState();
        try {
          const tab = await openSearchPage(t.searchUrl, p);
          t.activeTabId = tab.id;
          await saveState();
          notifyTab(tab.id, 'START', 1000, 45);
          r.enrichStop = false; // 重置停止标志，列表闹钟链才能拉起
          scheduleNextListTick(p, 2500); // 列表采集闹钟链启动
        } catch (e) {
          setStatus(p, 'ERROR', '打开页面失败：' + e.message);
          t.running = false;
          await saveState();
        }
        sendResponse({ ok: true, ...snapshot() });
        break;
      }

      case 'EXHAUSTED': {
        // 当前搜索词已无更多岗位：优先切换队列中的下一个搜索词
        // （主链路改由 listTick 判定后调 handleExhausted；此消息仅为兼容兜底）
        const p = platformFromTab(sender);
        const next = await handleExhausted(p);
        sendResponse({ ok: true, next });
        break;
      }

      case 'IS_RUNNING': {
        // 内容脚本自带平台标识；再验证标签页归属
        const p = validPlatform(msg.platform || platformFromTab(sender));
        const t = T(p);
        sendResponse({
          running: !!(t.running && sender.tab && sender.tab.id === t.activeTabId)
        });
        break;
      }

      case 'SHOULD_CONTINUE': {
        const p = platformFromTab(sender);
        const t = T(p);
        sendResponse({
          continue: t.running && t.collected.length < t.target
        });
        break;
      }

      case 'BATCH': {
        const p = platformFromTab(sender);
        const t = T(p);
        if (!t.running) {
          sendResponse({ ok: true, added: 0, total: t.collected.length });
          break;
        }
        let added = 0;
        const seen = new Set(t.collected.map(jobKey));
        for (const j of msg.jobs || []) {
          if (t.collected.length >= t.target) break;
          const k = jobKey(j);
          if (!k || seen.has(k)) continue;
          seen.add(k);
          j.collectedAt = Date.now();
          j.platform = p; // 数据归属平台标记（CSV导出用）
          t.collected.push(j);
          sanitizeJob(j); // 入库即校验修复：状态标签/公司名串位直接拦下
          added++;
        }
        if (t.collected.length >= t.target) {
          t.running = false;
          setStatus(p, 'DONE', `已达目标数量（${t.target} 条），开始补全JD详情…`);
          pushLog('OK', `[${PLAT[p].name}] 列表采集完成，共 ${t.collected.length} 条（达标），转入JD补全`);
          tellTabStop(p);
          scheduleEnrich(p);
        } else {
          setStatus(p, 'RUN', `采集中：${t.collected.length} / ${t.target} 条`);
        }
        await saveState();
        sendResponse({ ok: true, added, total: t.collected.length });
        break;
      }

      /* ---------- JD 详情补全 ---------- */
      case 'JD_RESULT': {
        // 兼容保留（当前详情采集由 enrichTick 闹钟步驱动，不再走内容脚本上报）
        const p = platformFromTab(sender);
        applyDetail(p, msg.key, msg.detail);
        await saveState();
        sendResponse({ ok: true });
        break;
      }

      case 'START_ENRICH_CMD': {
        const p = validPlatform(msg.platform);
        const t = T(p);
        const r = rt(p);
        if (!t.collected.length) {
          setStatus(p, 'WARN', '暂无数据，请先采集');
          sendResponse({ ok: false });
          break;
        }
        t.enrich = true;
        t.enrichScheduled = false; // 手动触发前重置，保证后续自动调度可用
        let tabId = t.activeTabId;
        if (!(await tabExists(tabId))) {
          const tab = await openSearchPage(t.searchUrl || PLAT[p].homeUrl, p);
          tabId = tab.id;
          t.activeTabId = tab.id;
          await saveState();
        }
        r.enrichStop = false;
        setStatus(p, 'ENRICH', '开始补全JD详情（模拟真人点击进出详情页）…');
        scheduleEnrich(p);
        sendResponse({ ok: true });
        break;
      }

      case 'SANITIZE': {
        // 全量校验修复：合并同键重复记录（同一岗位跨搜索词重复出现）+ 清洗字段 + 回填空值
        const p = validPlatform(msg.platform);
        const t = T(p);
        if (!t.collected.length) {
          setStatus(p, status[p].status === 'DONE' ? 'DONE' : 'IDLE', '暂无数据可校验');
          sendResponse({ ok: true, fixed: 0, ...snapshot() });
          break;
        }
        const byKey = new Map();
        const out = [];
        let merged = 0;
        let filled = 0;
        for (const j of t.collected) {
          const k = jobKey(j);
          const prev = byKey.get(k);
          if (!prev) {
            sanitizeJob(j);
            byKey.set(k, j);
            out.push(j);
            continue;
          }
          merged++;
          for (const f of ['name', 'salary', 'area', 'experience', 'education', 'skills', 'welfare', 'company', 'industry', 'scale', 'funding', 'jd', 'link']) {
            if (!prev[f] && j[f]) {
              prev[f] = j[f];
              filled++;
            }
          }
          if (j.detailFetched) {
            prev.detailFetched = true;
            prev.detailFetching = false;
            prev.detailVia = prev.detailVia || j.detailVia;
          }
          if (j.collectedAt && (!prev.collectedAt || j.collectedAt < prev.collectedAt)) prev.collectedAt = j.collectedAt;
        }
        // 修复被"导航失败级联"误标完成的记录：无JD且最后状态是基础设施故障 → 重置待补
        let repaired = 0;
        for (const j of out) {
          if (j.detailFetched && !j.jd && (j.detailVia === 'fail' || j.detailVia === 'no-tab')) {
            j.detailFetched = false;
            j.detailTries = 0;
            repaired++;
          }
        }
        const removed = t.collected.length - out.length;
        t.collected = out;
        await saveState();
        setStatus(p, status[p].status === 'DONE' ? 'DONE' : 'IDLE', `校验完成：合并 ${removed} 条重复、回填 ${filled} 个空字段${repaired ? `、重置 ${repaired} 条误标记录` : ''}`);
        pushLog('ACTION', `[${PLAT[p].name}] 校验修复：合并 ${removed} 条同键重复记录，回填 ${filled} 个空字段${repaired ? `，重置 ${repaired} 条因标签页丢失被误标的记录` : ''}`);
        sendResponse({ ok: true, fixed: merged, ...snapshot() });
        break;
      }

      case 'STATUS': {
        // 任务已结束后忽略普通进度，但保留 DONE/ERROR/WARN 等最终态
        const p = platformFromTab(sender);
        const t = T(p);
        if (t.running || msg.status !== 'RUN') setStatus(p, msg.status, msg.message);
        const LOGGED = ['WARN', 'ERROR', 'STOPPED', 'DONE', 'SWITCH', 'WAIT_CAPTCHA'];
        if (LOGGED.includes(msg.status)) {
          pushLog(msg.status === 'DONE' ? 'OK' : msg.status === 'SWITCH' || msg.status === 'WAIT_CAPTCHA' ? 'WARN' : msg.status, `[${PLAT[p].name}] ` + String(msg.message || '').slice(0, 300));
        }
        sendResponse({ ok: true });
        break;
      }

      case 'LOOP_END': {
        const p = platformFromTab(sender);
        const t = T(p);
        if (t.running && status[p].status === 'RUN') {
          t.running = false;
          setStatus(p, 'STOPPED', '内容脚本已停止（页面关闭或跳转）');
          await saveState();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'STOP': {
        const p = validPlatform(msg.platform);
        await manualStop(p, '已手动停止（可点"补全JD"继续补齐详情）');
        sendResponse({ ok: true, ...snapshot() });
        break;
      }

      case 'CLEAR': {
        const p = validPlatform(msg.platform);
        const t = T(p);
        t.collected = [];
        t.enrichScheduled = false;
        await saveState();
        setStatus(p, 'IDLE', '数据已清空');
        sendResponse({ ok: true, ...snapshot() });
        break;
      }

      case 'GET_STATE':
        sendResponse({ ok: true, ...snapshot() });
        break;

      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // 异步应答
});
