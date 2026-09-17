/**
 * BOSS岗位采集助手 —— background service worker
 *
 * 负责任务调度：
 *  - 打开/定位搜索页并通知 content script 开始采集
 *  - 接收增量数据，去重、汇总、控制总量（达到目标数量自动停止）
 *  - 目标达成后调度 JD 详情补全（逐条下发任务）
 *  - 状态持久化到 chrome.storage.local
 */
const STATE_KEY = 'boss_state';

let state = {
  running: false,
  enrich: true,        // 是否在采集后自动补全 JD 详情
  target: 100,
  collected: [],
  startedAt: null,
  searchUrl: '',
  queue: [],           // 搜索词 URL 队列（突破单搜索词 300 条上限）
  queueIndex: 0,
  enrichScheduled: false
};
let activeTabId = null;
let status = { status: 'IDLE', message: '空闲' };
let stateLoaded = false;

/* ---------- 状态持久化 ---------- */
async function loadState() {
  try {
    const d = await chrome.storage.local.get(STATE_KEY);
    if (d[STATE_KEY]) state = Object.assign(state, d[STATE_KEY]);
  } catch (e) { /* ignore */ }
  // 恢复非持久默认值（SW 休眠重启后不会丢失运行上下文）
  status = { status: state.status || 'IDLE', message: state.message || '空闲' };
  activeTabId = state.activeTabId || null;
  stateLoaded = true;
}
function saveState() {
  return chrome.storage.local.set({ [STATE_KEY]: state }).catch(() => {});
}

function setStatus(s, m) {
  status = { status: s, message: m };
  if (stateLoaded) {
    state.status = s;
    state.message = m;
    saveState();
  }
}

(async () => {
  await loadState();
  // 浏览器刚启动（session 标志不存在）：沿用既有语义，不自动恢复任务
  const { bootstrapped } = await chrome.storage.session.get('bootstrapped');
  if (!bootstrapped) {
    await chrome.storage.session.set({ bootstrapped: true });
    return;
  }
  // SW 曾被休眠重启（浏览器未重启）：恢复正在进行的任务现场
  if (state.running) {
    try {
      await chrome.tabs.get(activeTabId);
    } catch (e) {
      // 原标签页已丢失：重新打开搜索页
      try {
        const tab = await openSearchPage(state.searchUrl);
        activeTabId = tab.id;
        state.activeTabId = tab.id;
        await saveState();
      } catch (e2) {
        state.running = false;
        await saveState();
        setStatus('STOPPED', '标签页已丢失，请重新开始采集');
        return;
      }
    }
    setStatus('RUN', '检测到任务曾被中断，已自动恢复采集…');
    notifyTab(activeTabId, 'START', 1200, 30);
  } else if (state.enrichScheduled && state.collected.length) {
    // JD补全曾中断（enrichScheduled 已置位）：直接安排下一闹钟，勿走 scheduleEnrich（会因已置位被拒）
    enrichStop = false;
    scheduleNextTick(5000);
  }
})();

// 浏览器重启后，未完成的任务视为失效
chrome.runtime.onStartup.addListener(() => {
  loadState().then(() => {
    if (state.running) {
      state.running = false;
      status = { status: 'STOPPED', message: '浏览器重启，任务已中断' };
      return saveState();
    }
  });
});

/* ---------- 工具 ---------- */
function snapshot() {
  return {
    running: state.running,
    target: state.target,
    count: state.collected.length,
    status: status.status,
    message: status.message,
    jobs: state.collected
  };
}

function setStatus(s, m) {
  status = { status: s, message: m };
}

function linkKey(link) {
  try {
    const u = new URL(link);
    return (
      u.searchParams.get('jobId') ||
      u.searchParams.get('securityId') ||
      (u.pathname.match(/([0-9a-f]{16,})\.html/i) || [])[1] ||
      u.pathname
    );
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

function pendingCount() {
  return state.collected.filter((j) => !j.detailFetched).length;
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
  const BAD = /公司基本信息|查看更多|查看全部|展开|收起|举报|在招|融资轮次|人员规模/;
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

function tellTabStop() {
  if (activeTabId == null) return;
  try {
    chrome.tabs.sendMessage(activeTabId, { type: 'STOP' }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}

async function manualStop(reason) {
  state.running = false;
  state.enrichScheduled = false;
  enrichStop = true; // 同步中断闹钟驱动的 JD 采集
  try { await chrome.alarms.clear(ALARM_ENRICH); } catch (e) { /* ignore */ }
  await saveState();
  setStatus('STOPPED', reason);
  tellTabStop(); // 手动停止 = 全部停止；缺 JD 可之后点"补全JD"
}

// 调度 JD 补全（带去重，避免多处触发重复调度）；闹钟驱动，不依赖内容脚本与前台
function scheduleEnrich() {
  if (state.enrichScheduled) return;
  if (!state.enrich || pendingCount() === 0) return;
  state.enrichScheduled = true;
  enrichStop = false;
  saveState();
  setStatus('ENRICH', '开始补全JD详情（模拟真人点击进出详情页，可后台运行）…');
  scheduleNextTick(3000);
}

function openSearchPage(url) {
  return chrome.tabs.query({ url: 'https://www.zhipin.com/*' }).then((tabs) => {
    const t = tabs.find(
      (x) => x.url && (x.url.includes('/web/geek/jobs') || x.url.includes('/job_detail'))
    );
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

// —— JD 详情采集：后台驱动“热”标签页导航（最终架构）——
// 实测：BOSS 对每次程序化请求（fetch/iframe/新开冷标签页）都返回 JS 安检页；
// 只有用户已登录、有交互历史的“热”标签页做导航时，被动安检才会像手动点击一样自动通过。
// 因此详情采集复用搜索页标签页本身：导航进详情 → 提取 → 导航回列表，循环逐条进行。

let enrichStop = false;
let blockedStreak = 0;
let pausedUntil = 0; // 熔断：连续被风控拦截时暂停到该时间点
// —— 拟人节奏引擎 ——
let slowFactor = 1;      // 风控自适应减速：每次被拦截×1.5（上限4），每15条顺利×0.9（下限1）
let jobsSinceBreak = 0;
let nextBreakAt = 5 + Math.floor(Math.random() * 5); // 每5~9条随机长休一次
let cleanJobs = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拟人节奏：条间4~9s×减速因子；每5~9条插入30~90s长休（真人不会匀速刷几百条）。
// 以“下一次闹钟的延迟”表达——SW 可在等待中休眠，闹钟到点会唤醒它继续
function nextDelayMs() {
  jobsSinceBreak++;
  if (jobsSinceBreak >= nextBreakAt) {
    jobsSinceBreak = 0;
    nextBreakAt = 5 + Math.floor(Math.random() * 5);
    return 30000 + Math.random() * 60000;
  }
  return (4000 + Math.random() * 5000) * slowFactor;
}

async function tabTitle(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return t.title || '';
  } catch (e) {
    return '';
  }
}

// 导航热标签页到详情页并提取（完成后负责导航回列表页恢复现场）
async function warmTabDetail(link) {
  const tabId = activeTabId;
  if (tabId == null) return { jd: '', via: 'no-tab' };
  let listUrl = state.searchUrl;
  let winId = null;
  try {
    const t = await chrome.tabs.get(tabId);
    winId = t.windowId;
    if (!listUrl && t.url && /web\/geek\/jobs|job_list/.test(t.url)) listUrl = t.url;
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
    await chrome.tabs.update(tabId, { url: link });
    // 安检链：security.html(JS算令牌)→重定向回 job_detail。等 URL 落位（最多25s）
    let landed = await waitTabUrl(tabId, (u) => /job_detail\//.test(u || ''), 25000);
    if (!landed) {
      // 未落位：大概率是滑块/验证页，请人工完成（完成后 callbackUrl 会自动跳回详情页）
      const title = await tabTitle(tabId);
      if (/安全验证|验证码|请稍候|security/i.test(title)) {
        setStatus('WARN', '页面出现安全验证，请在当前标签页手动完成（滑块/点选），完成后自动继续…');
        landed = await waitTabUrl(tabId, (u) => /job_detail\//.test(u || ''), 120000);
      }
    }
    if (!landed) {
      return {
        jd: '', via: 'blocked',
        diag: { src: 'tab', title: await tabTitle(tabId), url: link, n: 0, text: '安检未通过（未落到详情页）' }
      };
    }
    await waitTabComplete(tabId, 15000);
    // 模拟真人阅读JD：在详情页停留片刻再返回列表（停留过短本身就是机器人特征）
    await sleep(1500 + Math.random() * 3000);
    // 先探测内容脚本已注入（最多6×1s），再提取；避免把“未注入”误判成“提取为空”
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
      } catch (e) { /* 注入也失败，走“未注入”诊断分支 */ }
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
    // 无论成败都导航回列表页恢复现场（用户能继续看到列表）
    if (listUrl) {
      try { await chrome.tabs.update(tabId, { url: listUrl }); } catch (e) { /* ignore */ }
      await waitTabComplete(tabId, 15000);
    }
  }
}

// 详情字段合并（enrichTick 闹钟步与 JD_RESULT 消息共用）
function applyDetail(key, d) {
  const j = state.collected.find((x) => jobKey(x) === key);
  if (!j) return null;
  d = d || {};
  j.jd = d.jd || '';
  j.welfare = d.welfare || j.welfare || '';
  j.salary = pickSalary(j.salary, d.salary); // 详情页薪资优先（已解密）；解密不全则保留列表薪资
  const comp = parseCompanyRaw(d.companyRaw, j.company);
  if (!j.company && comp.name) j.company = comp.name;
  j.industry = j.industry || comp.industry || '';
  j.scale = j.scale || comp.scale || '';
  j.funding = j.funding || comp.funding || '';
  j.area = j.area || d.area || '';
  sanitizeJob(j);
  j.detailVia = d.via || '';
  if (!d.jd && d.diag) j.detailDiag = d.diag; // 诊断：拿不到 JD 时记录页面指纹
  j.detailTries = (j.detailTries || 0) + 1;
  // 只有真抓到 JD 才算完成（空结果重试，最多 3 次）；必清 detailFetching 防死循环
  if (d.jd || j.detailTries >= 3) j.detailFetched = true;
  j.detailFetching = false;
  return j;
}

// 闹钟驱动的单步状态机：每步处理一条JD，随后安排下一次闹钟。
// SW 在步与步之间可以被浏览器休眠——闹钟到点会把它唤醒继续，
// 因此浏览器放后台/窗口最小化都不会中断任务（请求节奏不变，风控无感）
const ALARM_ENRICH = 'enrichTick';
let tickBusy = false;

function scheduleNextTick(delayMs) {
  if (enrichStop) return;
  chrome.alarms.create(ALARM_ENRICH, { when: Date.now() + Math.max(1000, delayMs) });
}

async function enrichTick() {
  if (tickBusy || enrichStop || !state.enrichScheduled) return;
  tickBusy = true;
  try {
    if (Date.now() < pausedUntil) {
      scheduleNextTick(pausedUntil - Date.now() + 1000); // 熔断冷却中，等解除
      return;
    }
    const now = Date.now();
    const retryable = (j) => j.detailFetching && now - (j.fetchStartedAt || 0) > 90000;
    const j = state.collected.find((x) => (!x.detailFetched && !x.detailFetching) || retryable(x));
    if (!j) {
      // 全部处理完
      state.enrichScheduled = false;
      await saveState();
      const left = pendingCount();
      if (left > 0) {
        setStatus('WARN', `JD补全结束：还剩 ${left} 条未取到（多为反复拿不到的岗位），可稍后再点"补全JD"重试`);
      } else if (state.collected.length) {
        setStatus('DONE', `全部完成 ✔ 共 ${state.collected.length} 条（含JD详情），可点击"导出CSV"`);
      }
      return;
    }
    const key = jobKey(j);
    j.detailFetching = true;
    j.fetchStartedAt = Date.now();
    await saveState();
    setStatus('ENRICH', `JD详情 ${state.collected.indexOf(j) + 1}/${state.collected.length}：${j.name}`);
    const d = await warmTabDetail(j.link);
    applyDetail(key, d);
    const done = state.collected.length - pendingCount();
    const tag = d.jd
      ? ` · 上条 ${(d.ms / 1000).toFixed(1)}s · ${d.jdVia || ''}`
      : d.via === 'blocked'
        ? ' · ⚠风控拦截'
        : d.diag
          ? ` · ${d.diag.title || '无标题'}(${d.diag.n || '?'}字)${d.diag.text ? ' ' + String(d.diag.text).slice(0, 60) : ''}`
          : ' · 未取到JD，稍后重试';
    setStatus('ENRICH', `JD获取中：已完成 ${done}/${state.collected.length}（还剩 ${pendingCount()}）${tag}`);

    // 计算下一步延迟（含风控应对与拟人节奏），以闹钟形式安排
    let delay = nextDelayMs();
    if (d.via === 'blocked') {
      blockedStreak++;
      slowFactor = Math.min(4, slowFactor * 1.5); // 被拦截立即整体减速
      if (blockedStreak === 1) {
        // 首次拦截就冷却：封禁期间继续请求只会延长封禁
        delay = 30000 + Math.random() * 30000;
        setStatus('WARN', '遇到风控拦截，冷却约1分钟后继续（已自动降低整体速度）…');
      }
      if (blockedStreak >= 3) {
        pausedUntil = Date.now() + 90000;
        setStatus('WARN', '连续遇到安全验证，暂停90秒后自动重试；若页面有滑块请手动完成');
      }
    } else if (d.jd) {
      blockedStreak = 0;
      cleanJobs++;
      if (cleanJobs % 15 === 0) slowFactor = Math.max(1, slowFactor * 0.9); // 顺利时缓慢恢复速度
      pausedUntil = 0;
    }
    if (Date.now() < pausedUntil) delay = Math.max(delay, pausedUntil - Date.now());
    scheduleNextTick(delay);
  } finally {
    tickBusy = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_ENRICH) enrichTick();
});

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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'START': {
        enrichStop = true; // 若旧采集在跑，立即停下（新调度启动时会重置）
        try { chrome.alarms.clear(ALARM_ENRICH); } catch (e) { /* ignore */ }
        state.target = msg.target || 100;
        state.enrich = msg.enrich !== false;
        state.collected = [];
        state.running = true;
        state.startedAt = Date.now();
        state.queue = (Array.isArray(msg.urls) && msg.urls.length ? msg.urls : [msg.url]).filter(Boolean);
        state.queueIndex = 0;
        state.searchUrl = state.queue[0] || '';
        state.enrichScheduled = false;
        state.concurrency = Math.max(1, Math.min(6, parseInt(msg.concurrency, 10) || 1));
        setStatus('RUN', '正在打开/定位搜索页面…');
        await saveState();
        try {
          const tab = await openSearchPage(state.searchUrl);
          activeTabId = tab.id;
          state.activeTabId = tab.id;
          await saveState();
          notifyTab(tab.id, 'START', 1000, 45);
        } catch (e) {
          setStatus('ERROR', '打开页面失败：' + e.message);
          state.running = false;
          await saveState();
        }
        sendResponse({ ok: true, ...snapshot() });
        break;
      }

      case 'EXHAUSTED': {
        // 当前搜索词已无更多岗位：优先切换队列中的下一个搜索词
        if (state.running && state.queueIndex + 1 < (state.queue || []).length) {
          state.queueIndex++;
          state.searchUrl = state.queue[state.queueIndex];
          // 注意：状态用 SWITCH 而非 RUN，避免随后的 LOOP_END 误判为异常停止而中断接力
          setStatus('SWITCH', `当前搜索词已采尽，自动切换下一搜索词（${state.queueIndex + 1}/${state.queue.length}）…`);
          await saveState();
          try { await chrome.tabs.update(activeTabId, { url: state.searchUrl }); } catch (e) { /* ignore */ }
          sendResponse({ ok: true, next: true });
          break;
        }
        // 队列也空了：收尾并补全 JD
        state.running = false;
        const total = state.collected.length;
        setStatus(
          'DONE',
          `全部搜索词采集完毕，共 ${total} 条（BOSS 单搜索词上限约300条，可增加关键词扩大范围）`
        );
        await saveState();
        scheduleEnrich();
        sendResponse({ ok: true, next: false });
        break;
      }

      case 'IS_RUNNING':
        sendResponse({
          running: !!(state.running && sender.tab && sender.tab.id === activeTabId)
        });
        break;

      case 'SHOULD_CONTINUE':
        sendResponse({
          continue: state.running && state.collected.length < state.target
        });
        break;

      case 'BATCH': {
        if (!state.running) {
          sendResponse({ ok: true, added: 0, total: state.collected.length });
          break;
        }
        let added = 0;
        const seen = new Set(state.collected.map(jobKey));
        for (const j of msg.jobs || []) {
          if (state.collected.length >= state.target) break;
          const k = jobKey(j);
          if (!k || seen.has(k)) continue;
          seen.add(k);
          j.collectedAt = Date.now();
          state.collected.push(j);
          sanitizeJob(j); // 入库即校验修复：状态标签/公司名串位直接拦下
          added++;
        }
        if (state.collected.length >= state.target) {
          state.running = false;
          setStatus('DONE', `已达目标数量（${state.target} 条），开始补全JD详情…`);
          tellTabStop();
          scheduleEnrich();
        } else {
          setStatus('RUN', `采集中：${state.collected.length} / ${state.target} 条`);
        }
        await saveState();
        sendResponse({ ok: true, added, total: state.collected.length });
        break;
      }

      /* ---------- JD 详情补全 ---------- */
      case 'JD_RESULT': {
        // 兼容保留（当前详情采集由 enrichTick 闹钟步驱动，不再走内容脚本上报）
        applyDetail(msg.key, msg.detail);
        await saveState();
        sendResponse({ ok: true });
        break;
      }

      case 'START_ENRICH_CMD': {
        if (!state.collected.length) {
          setStatus('WARN', '暂无数据，请先采集');
          sendResponse({ ok: false });
          break;
        }
        state.enrich = true;
        state.enrichScheduled = false; // 手动触发前重置，保证后续自动调度可用
        state.concurrency = Math.max(1, Math.min(6, parseInt(msg.concurrency, 10) || 1));
        let tabId = activeTabId;
        if (!(await tabExists(tabId))) {
          const tab = await openSearchPage(
            state.searchUrl || 'https://www.zhipin.com/web/geek/jobs?query=RPA&city=101280100'
          );
          tabId = tab.id;
          activeTabId = tab.id;
          state.activeTabId = tab.id;
          await saveState();
        }
        setStatus('ENRICH', '开始补全JD详情（模拟真人点击进出详情页）…');
        scheduleEnrich();
        sendResponse({ ok: true });
        break;
      }

      case 'SANITIZE': {
        // 对已采集数据做全量校验修复（清洗历史脏数据，无需重新采集）
        if (!state.collected.length) {
          setStatus(status.status === 'DONE' ? 'DONE' : 'IDLE', '暂无数据可校验');
          sendResponse({ ok: true, fixed: 0, ...snapshot() });
          break;
        }
        let fixed = 0;
        state.collected.forEach((j) => { if (sanitizeJob(j)) fixed++; });
        await saveState();
        setStatus(status.status === 'DONE' ? 'DONE' : 'IDLE', `校验完成：清理/修复 ${fixed} 条记录的异常值`);
        sendResponse({ ok: true, fixed, ...snapshot() });
        break;
      }

      case 'STATUS':
        // 任务已结束后忽略普通进度，但保留 DONE/ERROR/WARN 等最终态
        if (state.running || msg.status !== 'RUN') setStatus(msg.status, msg.message);
        sendResponse({ ok: true });
        break;

      case 'LOOP_END':
        if (state.running && status.status === 'RUN') {
          state.running = false;
          setStatus('STOPPED', '内容脚本已停止（页面关闭或跳转）');
          await saveState();
        }
        sendResponse({ ok: true });
        break;

      case 'STOP':
        await manualStop('已手动停止（可点"补全JD"继续补齐详情）');
        sendResponse({ ok: true, ...snapshot() });
        break;

      case 'CLEAR':
        state.collected = [];
        state.enrichScheduled = false;
        await saveState();
        setStatus('IDLE', '数据已清空');
        sendResponse({ ok: true, ...snapshot() });
        break;

      case 'GET_STATE':
        sendResponse({ ok: true, ...snapshot() });
        break;

      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // 异步应答
});

// 兼容旧调用名
function notifyEnrichWrap() {
  scheduleEnrich();
}
function notifyEnrich(tabId) {
  if (activeTabId == null || tabId === activeTabId) scheduleEnrich();
}
