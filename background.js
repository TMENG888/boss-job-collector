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

/* ---------- 状态持久化 ---------- */
async function loadState() {
  try {
    const d = await chrome.storage.local.get(STATE_KEY);
    if (d[STATE_KEY]) state = Object.assign(state, d[STATE_KEY]);
  } catch (e) { /* ignore */ }
}
function saveState() {
  return chrome.storage.local.set({ [STATE_KEY]: state }).catch(() => {});
}

loadState();

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
  await saveState();
  setStatus('STOPPED', reason);
  tellTabStop(); // 手动停止 = 全部停止；缺 JD 可之后点"补全JD"
}

// 调度 JD 补全（带去重，避免多处触发重复调度）
function scheduleEnrich() {
  if (state.enrichScheduled) return;
  if (!state.enrich || pendingCount() === 0) return;
  state.enrichScheduled = true;
  saveState();
  setStatus('ENRICH', '开始补全JD详情…');
  notifyTab(activeTabId, 'START_ENRICH', 1500, 40);
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

// —— 真实标签页导航提取（tab 兜底通道）——
// fetch/iframe 是程序化上下文，BOSS 可能对其返回空壳；真实导航与用户点击行为一致。
// 串行化：同时只开一个详情标签页（真实导航较重，且降低风控关注）
let detailTabChain = Promise.resolve();

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

function tabExtractDetail(link) {
  const run = async () => {
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: link, active: false });
      // 安检链：security.html(JS算令牌)→重定向回 job_detail。等 URL 落位（最多25s）
      const landed = await waitTabUrl(tab.id, (u) => /job_detail\//.test(u || ''), 25000);
      if (landed) await waitTabComplete(tab.id, 15000);
      // 页面内脚本等水合（最多8s）后提取；内容脚本未就绪则重试下发
      // 整体预算 ~55s，小于 content 侧 TAB_DETAIL 的 90s 硬超时
      let resp = null;
      for (let i = 0; i < 2; i++) {
        try {
          resp = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_DETAIL' });
          if (resp && resp.detail && resp.detail.jd) break;
        } catch (e) { /* 尚未就绪，稍后重试 */ }
        await new Promise((r) => setTimeout(r, 1500));
      }
      return (
        (resp && resp.detail) || { jd: '', salary: '', welfare: '', area: '', companyRaw: '', via: 'tab' }
      );
    } catch (e) {
      return {
        jd: '', salary: '', welfare: '', area: '', companyRaw: '', via: 'tab',
        diag: { src: 'tab', title: '打开详情页失败', url: link, n: 0, text: String((e && e.message) || e).slice(0, 120) }
      };
    } finally {
      if (tab && tab.id) {
        try { await chrome.tabs.remove(tab.id); } catch (e) { /* ignore */ }
      }
    }
  };
  const p = detailTabChain.then(run, run);
  detailTabChain = p.catch(() => {});
  return p;
}

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
      case 'GET_CONCURRENCY': {
        sendResponse({ concurrency: state.concurrency || 1 });
        break;
      }
      case 'TAB_DETAIL': {
        // 真实标签页导航提取：详情请求拿不到内容时的终极兑底
        const detail = await tabExtractDetail(String(msg.link || ''));
        sendResponse({ detail });
        break;
      }
      case 'GET_NEXT_PENDING': {
        const now = Date.now();
        // 超过 60s 未返回的任务视为失败，可重试
        const retryable = (j) => j.detailFetching && now - (j.fetchStartedAt || 0) > 60000;
        const pending = state.collected.filter((x) => !x.detailFetched || retryable(x));
        if (!pending.length || !state.enrich) {
          sendResponse({ job: null, pending: 0, total: state.collected.length });
          break;
        }
        const j = pending[0];
        j.detailFetching = true;
        j.fetchStartedAt = now;
        await saveState();
        sendResponse({
          job: { key: jobKey(j), link: j.link, name: j.name, no: state.collected.indexOf(j) + 1 },
          pending: pending.length,
          total: state.collected.length
        });
        break;
      }

      case 'JD_RESULT': {
        const j = state.collected.find((x) => jobKey(x) === msg.key);
        if (j) {
          const d = msg.detail || {};
          j.jd = d.jd || '';
          j.welfare = d.welfare || j.welfare || '';
          j.salary = pickSalary(j.salary, d.salary); // 详情页薪资直接并入"薪资"字段
          const comp = parseCompanyRaw(d.companyRaw, j.company);
          if (!j.company && comp.name) j.company = comp.name;
          j.industry = j.industry || comp.industry || '';
          j.scale = j.scale || comp.scale || '';
          j.funding = j.funding || comp.funding || '';
          j.area = j.area || d.area || '';
          sanitizeJob(j); // 终校验修复
          j.detailVia = d.via || '';
          // 诊断：拿不到 JD 时记录实际返回的页面指纹（登录墙/空壳/重定向一眼可见）
          if (!d.jd && d.diag) j.detailDiag = d.diag;
          // 只有真抓到 JD 才算完成（空结果重试，最多 3 次）；无论成败都清 detailFetching，
          // 否则 60s 后 retryable() 会把任务误判为超时可重试，worker 死循环重抓最早一批
          j.detailTries = (j.detailTries || 0) + 1;
          if (d.jd || j.detailTries >= 3) j.detailFetched = true;
          j.detailFetching = false;
          const left = pendingCount();
          if (left > 0) {
            const dg = d.diag;
            const tag = dg
              ? ` · 页面:"${dg.title || '无标题'}"(${dg.n || '?'}字)`
              : d.via === 'blocked'
                ? ' · ⚠风控拦截'
                : d.ms ? ` · 上条 ${d.ms}ms` : '';
            setStatus('ENRICH', `JD获取中：还剩 ${left} 条（已完成 ${state.collected.length - left}/${state.collected.length}）${tag}`);
          } else {
            state.enrichScheduled = false;
            setStatus('DONE', `全部完成 ✔ 共 ${state.collected.length} 条（含JD详情），可点击"导出CSV"`);
          }
          await saveState();
        }
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
        }
        setStatus('ENRICH', '开始补全JD详情…');
        notifyTab(tabId, 'START_ENRICH');
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
