/**
 * BOSS岗位采集助手 —— content script
 *
 * 运行在 www.zhipin.com 页面中，负责：
 *  1. 逐屏增量解析岗位卡片（每步上报，够数即停，不整页滚动）
 *  2. 点击"下一页"自动翻页
 *  3. 薪资字体加密解密（PUA 字形 canvas 渲染 + 模板匹配）
 *  4. fetch/iframe 获取职位详情页 JD 文本
 *  5. 通过消息与 background 通信，由 background 控制启停与数据汇总
 *
 * ⚠️ BOSS 偶尔会改版，若解析失败/翻页失败，优先修改下方 SEL 里的选择器。
 */
(() => {
  if (window.__BOSS_COLLECTOR__) return;
  window.__BOSS_COLLECTOR__ = true;

  /* ================= 可配置参数 ================= */
  const CONFIG = {
    pageDelay: [4000, 8000],    // 翻页之间随机停留区间（毫秒），模拟人工
    scrollDelay: 350,           // 滚动步进间隔（毫秒）
    cardWaitTimeout: 20000,     // 等待岗位卡片渲染的超时
    pageChangeTimeout: 15000,   // 翻页后等待列表变化的超时
    captchaWaitTimeout: 180000, // 等待人工完成安全验证的超时
    maxScrollSteps: 60,         // 单页最大滚动步数
    detailTimeout: 12000,       // 详情页 fetch 超时
    jdDelay: [700, 1600]        // 逐条获取JD的间隔
  };

  /* ====== 选择器：按顺序尝试，BOSS 改版后在这里补新选择器即可 ====== */
  const SEL = {
    card: [
      'li.job-card-wrapper',
      '.job-card-wrapper',
      'li[ka^="search_list"]',
      'li[ka^="job-list"]',
      '.job-card-box',
      '.job-primary'
    ],
    jobName: ['.job-name', '.job-title .name', '.job-title a', '.job-title'],
    salary: ['.salary', '.job-salary'],
    area: ['.job-area', '.job-area-wrapper .job-area', '.job-area-wrapper'],
    tag: [
      '.job-card-footer .tag-list li',
      '.job-info .tag-list li',
      '.job-tags li',
      'ul.tag-list li'
    ],
    company: ['.company-name a', '.company-name', 'a[href*="/gongsi/"]', '[class*="company-name"]', '.company-info a', '.company-box .name', '.name a'],
    companyTag: [
      '.company-tag-list li',
      '.company-box .company-tag-list li',
      '.company-tags li',
      '.company-box ul li'
    ],
    hr: ['.info-public', '.boss-name', '[class*="boss-name"]'],
    pubTime: ['.info-pub-time', '.job-pub-time', '.pub-time', '[class*="pub-time"]', '[class*="active-time"]'],
    next: ['a[ka="page-next"]', '[ka="page-next"]', '.page-next', '.ui-icon-arrow-page-next']
  };

  /* ====== 详情页选择器（fetch / iframe 两种方式共用） ====== */
  const SEL_DETAIL = {
    jd: [
      '.job-sec-text',
      '.detail-content',
      '[class*="job-sec-text"]',
      '[class*="detail-content"]',
      '.job-detail-section'
    ],
    salary: ['.job-banner .salary', '.salary', '.job-salary', '[class*="salary"]'],
    area: ['.location-address', '[class*="location-address"]', '[class*="job-address"]'],
    welfare: ['.job-keywords li', '.job-tags li', '.tag-card li', '.job-tags span', '.job-good-items li'],
    companyBlock: ['.sider-company', '.company-info', '[class*="sider-company"]']
  };

  const CAPTCHA_SEL =
    '.nc-container,.nc_wrapper,#nc_1_wrapper,.geetest_panel,.geetest_window,' +
    'iframe[src*="captcha"],iframe[src*="geetest"],iframe[src*="verify"],' +
    '[class*="sec-code"],[class*="verify-wrap"],[class*="captcha"]';

  // 时间文本分类：活跃状态 vs 发布时间
  const ACTIVE_TXT_RE = /(今日活跃|刚刚活跃|本月活跃|在线|刚刚)/;
  const PUB_TXT_RE = /(发布|今天|昨天|刚刚|\d+分钟前|\d+小时前|\d+天前|\d{4}[-/]\d{1,2}[-/]\d{1,2})/;

  const SALARY_RE =
    /((?:\d+(?:\.\d+)?)\s*[-–~]\s*(?:\d+(?:\.\d+)?)\s*[Kk万W]?(?:\s*·\s*\d+薪)?|(?:\d+(?:\.\d+)?)\s*[Kk万](?:\s*·\s*\d+薪)?|\d+\s*元\s*\/\s*[天日月]|面议)/;
  const EXP_RE = /(应届生?|在校\/应届|在校生|实习|\d+\s*-\s*\d+年|\d+年以上|1年以内|经验不限|无需经验)/;
  const EDU_RE = /(初中及以下|高中|中专\/中技|大专|本科|硕士|博士|学历不限)/;
  const SCALE_RE = /(\d+\s*-\s*\d+人|少于\d+人|\d+人以上|\d+人以下)/;
  const FUND_RE =
    /(不需要融资|未融资|天使轮|A轮|B轮|C轮|D轮|已上市|国企|央企|民营|合资|外资|事业单位|独角兽)/;
  const AREA_RE = /[\u4e00-\u9fa5]{2,8}·[\u4e00-\u9fa5]{1,12}/;

  /* ================= 小工具 ================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sleepR = ([a, b]) => sleep(a + Math.random() * (b - a));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const pageHeight = () =>
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

  function fire(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) { /* 扩展上下文失效，忽略 */ }
  }
  function ask(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }
  function report(status, message) {
    fire({ type: 'STATUS', status, message });
  }
  // 保留换行的文本提取（JD 用）
  function blockText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    return clone.textContent
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
  }

  // 清洗 HR 名：去掉“·今日活跃”之类的尾巴
  function cleanHR(t) {
    return String(t || '')
      .replace(/[·\s]*(今日活跃|刚刚活跃|本月活跃|在线|刚刚).*$/, '')
      .trim();
  }

  function qsa(list, root = document) {
    for (const s of list) {
      const els = root.querySelectorAll(s);
      if (els.length) return Array.from(els);
    }
    return [];
  }
  function qsOne(list, root = document) {
    for (const s of list) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  /* ================= 薪资字体解密（PUA 字形模板匹配） =================
   * BOSS 用自定义字体把数字渲染成 PUA 私有区字符（textContent 里是乱码），
   * 浏览器显示正常。原理：把 PUA 字形用页面已加载的自定义字体画到 canvas，
   * 与"0-9 K · + - x"等参考字形（多字体模板）做归一化相似度匹配，取最高分。
   * 相当于一次轻量 OCR，无需第三方字体解析库。
   */
  const FontDecoder = (() => {
    const PUA_RE = /[\uE000-\uF8FF]/;
    const REF_CHARS = ['0','1','2','3','4','5','6','7','8','9','K','k','·','+','-','x','X'];
    const REF_FONTS = ['Arial', '"Microsoft YaHei"', 'sans-serif', 'Georgia', '"Courier New"'];
    const SIZE = 90, N = 28;
    let ready = null;      // Promise<boolean>
    let family = null;     // 识别出的自定义字体
    let templates = null;  // [{ch, grid}]
    let tofuGrid = null;   // 豆腐块基准（用于缺字过滤）
    const TOFU_CP = '\u0378'; // 未分配码位，用于生成豆腐块基准
    const cache = new Map();

    function renderChar(ch, fontSpec) {
      const cv = document.createElement('canvas');
      cv.width = SIZE; cv.height = SIZE;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'middle';
      ctx.font = `${SIZE}px ${fontSpec}`;
      ctx.fillText(ch, 4, SIZE / 2);
      const img = ctx.getImageData(0, 0, SIZE, SIZE).data;
      let minX = SIZE, minY = SIZE, maxX = -1, maxY = -1;
      const mask = new Uint8Array(SIZE * SIZE);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (img[(y * SIZE + x) * 4 + 3] > 120) {
            mask[y * SIZE + x] = 1;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      const w = maxX - minX + 1, h = maxY - minY + 1;
      const bin = new Uint8Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) bin[y * w + x] = mask[(y + minY) * SIZE + (x + minX)];
      return { bin, w, h };
    }

    // 缩放到 N×N 网格（按格子占比，带轻微容差）
    function toGrid(g) {
      const out = new Float32Array(N * N);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const x0 = Math.floor(x * g.w / N), x1 = Math.max(x0 + 1, Math.floor((x + 1) * g.w / N));
          const y0 = Math.floor(y * g.h / N), y1 = Math.max(y0 + 1, Math.floor((y + 1) * g.h / N));
          let on = 0, tot = 0;
          for (let yy = y0; yy < y1; yy++)
            for (let xx = x0; xx < x1; xx++) { tot++; if (g.bin[yy * g.w + xx]) on++; }
          out[y * N + x] = tot ? on / tot : 0;
        }
      }
      return out;
    }

    function similarity(a, b) {
      let inter = 0, union = 0;
      for (let i = 0; i < a.length; i++) {
        inter += Math.min(a[i], b[i]);
        union += Math.max(a[i], b[i]);
      }
      return union ? inter / union : 0;
    }

    function buildTemplates() {
      templates = [];
      for (const ch of REF_CHARS) {
        for (const f of REF_FONTS) {
          const g = renderChar(ch, `${SIZE}px ${f}`);
          if (g) templates.push({ ch, grid: toGrid(g) });
        }
      }
      // 自定义字体自带的 ASCII 数字/字母字形（PUA 字形常与其完全同形）：加入精确模板
      // 用未分配码位生成豆腐块基准，排除字体缺字产生的假模板
      tofuGrid = toGrid(renderChar(TOFU_CP, `${SIZE}px "${family}"`)) || null;
      if (family) {
        for (const ch of REF_CHARS) {
          const g = renderChar(ch, `${SIZE}px "${family}"`);
          if (!g) continue;
          const grid = toGrid(g);
          if (tofuGrid && similarity(grid, tofuGrid) > 0.9) continue; // 字体缺该字形
          templates.push({ ch, grid });
        }
      }
    }

    function matchGlyph(ch) {
      const g = renderChar(ch, `${SIZE}px "${family}"`);
      if (!g) return null;
      const grid = toGrid(g);
      if (tofuGrid && similarity(grid, tofuGrid) > 0.9) return null; // 字体未覆盖该码位
      let best = { ch: null, score: 0 }, second = 0;
      for (const t of templates) {
        const s = similarity(grid, t.grid);
        if (s > best.score) { second = best.score; best = { ch: t.ch, score: s }; }
        else if (s > second) second = s;
      }
      if (best.score >= 0.55 && best.score - second >= 0.05) return best.ch;
      if (best.score >= 0.7) return best.ch;
      return null;
    }

    async function init(salaryEl) {
      if (ready) return ready;
      ready = (async () => {
        try {
          if (!document.fonts || !document.fonts.size) return false;
          // 1) 候选字体：优先真实薪资元素的计算字体，再叠加 document.fonts 里的所有字体
          const fams = [];
          const pushFam = (f) => {
            f = String(f).replace(/["']/g, '').trim();
            if (f && !fams.includes(f)) fams.push(f);
          };
          try {
            if (salaryEl) getComputedStyle(salaryEl).fontFamily.split(',').forEach(pushFam);
          } catch (e) { /* ignore */ }
          document.fonts.forEach((f) => pushFam(f.family));

          // 2) 采样 PUA 加密字符
          const samples = [];
          const els = salaryEl ? [salaryEl] : Array.from(document.querySelectorAll('.salary, .job-salary')).slice(0, 6);
          for (const el of els) {
            const m = (el.textContent || '').match(/[\uE000-\uF8FF]/g);
            if (m) samples.push(...m.slice(0, 10));
          }

          // 3) 逐个字体验证：用 fonts.check 确认字体确实覆盖 PUA 码位，再用样本命中率验收
          const GENERIC = /helvetica|arial|yahei|pingfang|songti|simsun|simhei|kaiti|fangsong|roboto|segoe|sans|serif|mono|icon|system|ui/i;
          const ordered = fams.filter((f) => !GENERIC.test(f)).concat(fams.filter((f) => GENERIC.test(f)));
          for (const f of ordered) {
            try {
              await document.fonts.load(`${SIZE}px "${f}"`, (samples[0] || '\uE000') + '0123456789K');
            } catch (e) { /* ignore */ }
            if (samples.length) {
              let covered = 0;
              for (const c of samples.slice(0, 6)) {
                try { if (document.fonts.check(`${SIZE}px "${f}"`, c)) covered++; } catch (e) { /* ignore */ }
              }
              if (covered === 0) continue; // 该字体不包含加密字符，跳过
            }
            family = f;
            buildTemplates();
            if (samples.length) {
              let hit = 0;
              for (const c of samples.slice(0, 10)) if (matchGlyph(c)) hit++;
              if (hit >= Math.max(1, Math.ceil(samples.length * 0.4))) { cache.clear(); return true; }
            } else {
              for (let cp = 0xE100; cp < 0xE140; cp++)
                if (matchGlyph(String.fromCharCode(cp))) { cache.clear(); return true; }
            }
          }
          family = null;
          return false;
        } catch (e) {
          family = null;
          return false;
        }
      })();
      return ready;
    }

    function decodeText(text) {
      text = text || '';
      if (!PUA_RE.test(text)) return text;
      if (!family) return text.replace(/[\uE000-\uF8FF]/g, '□'); // 解密不可用时显式占位，避免隐形乱码
      let out = '';
      for (const ch of text) {
        if (!PUA_RE.test(ch)) { out += ch; continue; }
        if (cache.has(ch)) { out += cache.get(ch) ?? '□'; continue; }
        const r = matchGlyph(ch);
        cache.set(ch, r);
        out += r ?? '□'; // 解不出的字形保留占位符，便于人工核查
      }
      return out;
    }

    return { init, decodeText, isPUA: (t) => PUA_RE.test(t || '') };
  })();

  /* ================= 解析岗位卡片 ================= */
  function findCards() {
    let cards = qsa(SEL.card);
    if (cards.length > 1) {
      cards = cards.filter((c) => !cards.some((o) => o !== c && c.contains(o)));
    }
    return cards;
  }

  function parseCard(card) {
    try {
      const nameEl = qsOne(SEL.jobName, card);
      const name = nameEl ? nameEl.getAttribute('title') || txt(nameEl) : '';
      if (!name) return null;

      // 优先取职位详情链接，避免拿到公司链接
      const anchors = Array.from(card.querySelectorAll('a[href]'));
      const a =
        anchors.find((x) => /job_detail|jobId=|securityId=/.test(x.getAttribute('href') || '')) ||
        anchors[0] || null;
      let link = '';
      if (a) {
        try { link = new URL(a.getAttribute('href'), location.origin).href; } catch (e) { /* ignore */ }
      }

      const salaryEl = qsOne(SEL.salary, card);
      const salary = txt(salaryEl) || (txt(card).match(SALARY_RE) || [''])[0];

      const areaEl = qsOne(SEL.area, card);
      const area = txt(areaEl) || (txt(card).match(AREA_RE) || [''])[0];

      const tags = qsa(SEL.tag, card).map(txt).filter(Boolean);
      const cardText = txt(card);
      let experience = tags.find((t) => EXP_RE.test(t)) || '';
      if (!experience) experience = (cardText.match(EXP_RE) || [''])[0];
      let education = tags.find((t) => EDU_RE.test(t)) || '';
      if (!education) education = (cardText.match(EDU_RE) || [''])[0];
      const skills = tags.filter((t) => t !== experience && t !== education).join('、');

      const companyEl = qsOne(SEL.company, card);
      const company = companyEl ? companyEl.getAttribute('title') || txt(companyEl) : '';

      const cTags = qsa(SEL.companyTag, card).map(txt).filter(Boolean);
      const scale = cTags.find((t) => SCALE_RE.test(t)) || (cardText.match(SCALE_RE) || [''])[0];
      const funding = cTags.find((t) => FUND_RE.test(t)) || (cardText.match(FUND_RE) || [''])[0];
      const industry = cTags.filter((t) => t !== scale && t !== funding).join('、');

      let pubTime = '', hrActive = '';
      const ptRaw = txt(qsOne(SEL.pubTime, card));
      if (ptRaw) {
        // BOSS 卡片上多是“今日活跃”类状态，发布时间几乎不展示：分开归类，避免值与列名不匹配
        if (ACTIVE_TXT_RE.test(ptRaw)) hrActive = ptRaw;
        else if (PUB_TXT_RE.test(ptRaw)) pubTime = ptRaw;
      }

      return {
        name, salary, area, experience, education, skills,
        company, industry, scale, funding,
        hr: cleanHR(txt(qsOne(SEL.hr, card))),
        pubTime, hrActive,
        link
      };
    } catch (e) {
      return null;
    }
  }

  let decodeWarned = false;
  async function parseCardAsync(card) {
    const j = parseCard(card);
    if (!j) return null;
    if (FontDecoder.isPUA(j.salary)) {
      // 传入真实薪资元素：用它的计算字体定位加密字体，比盲猜可靠得多
      const ok = await FontDecoder.init(qsOne(SEL.salary, card));
      j.salary = FontDecoder.decodeText(j.salary); // 解密不可用时以□占位，避免隐形乱码
      if (!ok && !decodeWarned) {
        decodeWarned = true;
        report('WARN', '薪资含加密字符且自动解密未成功，对应数字将以□显示');
      }
    }
    return j;
  }

  /* ================= 逐屏增量采集（够数即停） ================= */
  async function collectPageIncrementally() {
    const seen = new Set();
    const grabVisible = async () => {
      const fresh = [];
      for (const c of findCards()) {
        const j = await parseCardAsync(c);
        if (!j) continue;
        const k = j.link || `${j.name}|${j.company}|${j.salary}`;
        if (seen.has(k)) continue;
        seen.add(k);
        fresh.push(j);
      }
      if (fresh.length) {
        fire({ type: 'BATCH', jobs: fresh });
        await sleep(250);
      }
      return fresh.length;
    };

    // 首屏可见的卡片（通常就有 10~30 条，目标小的话到这就够了）
    await grabVisible();
    let cont = await ask({ type: 'SHOULD_CONTINUE' });
    if (!cont || !cont.continue) return 'STOPPED';

    for (let i = 0; i < CONFIG.maxScrollSteps; i++) {
      window.scrollBy(0, 500);
      await sleep(CONFIG.scrollDelay + Math.random() * 250);
      await grabVisible();
      if (window.innerHeight + window.scrollY >= pageHeight() - 60) break;
      cont = await ask({ type: 'SHOULD_CONTINUE' });
      if (!cont || !cont.continue) return 'STOPPED';
    }
    return 'PAGE_DONE';
  }

  async function scrollThroughPage() {
    for (let i = 0; i < CONFIG.maxScrollSteps; i++) {
      window.scrollBy(0, 500);
      await sleep(CONFIG.scrollDelay + Math.random() * 250);
      if (window.innerHeight + window.scrollY >= pageHeight() - 60) break;
    }
  }

  /* ================= 安全验证 / 卡片等待 ================= */
  function detectCaptcha() {
    try { return !!document.querySelector(CAPTCHA_SEL); } catch (e) { return false; }
  }

  async function waitCaptchaGone() {
    const t0 = Date.now();
    while (Date.now() - t0 < CONFIG.captchaWaitTimeout) {
      if (!detectCaptcha()) return true;
      await sleep(2000);
    }
    return false;
  }

  async function waitCards(timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (detectCaptcha()) return { ok: false, captcha: true };
      if (findCards().length) return { ok: true };
      await sleep(800);
    }
    return { ok: false, captcha: detectCaptcha() };
  }

  /* ================= 翻页 ================= */
  function firstCardKey() {
    const c = findCards()[0];
    if (!c) return '';
    const a = c.querySelector('a[href]');
    return a ? a.getAttribute('href') : txt(c).slice(0, 40);
  }

  function findNextButton() {
    for (const s of SEL.next) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    const boxes = document.querySelectorAll(
      'div[class*="page"],div[class*="pager"],div[class*="pagination"],ul[class*="page"]'
    );
    for (const box of boxes) {
      const els = box.querySelectorAll('a,li,button,span,i,div');
      for (const el of els) {
        const t = txt(el);
        const label =
          (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
        if (t === '下一页' || label.includes('下一页') || label.toLowerCase() === 'next') return el;
        const cls = String(el.className || '');
        if (/arrow/i.test(cls) && /right|next/i.test(cls) && !/disabled|ban/i.test(cls)) return el;
      }
    }
    return null;
  }

  function isDisabled(el) {
    if (!el) return true;
    const li = el.closest('li');
    const cls = String(el.className || '') + ' ' + (li ? String(li.className || '') : '');
    return (
      /disabled|no-more|ban|noplay/i.test(cls) || el.getAttribute('aria-disabled') === 'true'
    );
  }

  async function gotoNextPage() {
    const before = firstCardKey();
    const countBefore = findCards().length;
    const btn = findNextButton();

    if (btn && !isDisabled(btn)) {
      btn.click();
      const t0 = Date.now();
      while (Date.now() - t0 < CONFIG.pageChangeTimeout) {
        await sleep(700);
        if (detectCaptcha()) {
          report('WAIT_CAPTCHA', '检测到安全验证，请在页面上手动完成…');
          await waitCaptchaGone();
        }
        const now = firstCardKey();
        if (now && now !== before) {
          window.scrollTo(0, 0);
          return true;
        }
      }
      return false;
    }

    // 没有分页按钮：可能是无限滚动流，尝试滚动加载
    report('RUN', '未找到分页按钮，尝试滚动加载更多…');
    for (let round = 0; round < 3; round++) {
      await scrollThroughPage();
      await sleep(1500);
      if (findCards().length > countBefore) return true;
    }
    return false;
  }

  /* ================= JD 详情获取 ================= */
  /* ================= 详情页字段提取 ================= */
  // HR 姓名/职位：位于“立即沟通”按钮附近，按 token 形态识别，避免抓到公司名
  function extractHRInfo(root) {
    const BAD =
      /公司|有限|集团|科技|网络|信息|直聘|BOSS|查看|更多|活跃|在线|立即|沟通|职位|实习|工程师|开发|设计|运营|天|周|月|薪|元|K|招聘|最新|急聘|热招|停招|全职|兼职|远程|简历|投递/;
    const TITLE_RE = /(招聘者|人事|HR|猎头|[\u4e00-\u9fa5]{1,6}(?:经理|主管|总监|专员|顾问|合伙人|负责人))/;
    const ACTIVE_RE = /(今日活跃|刚刚活跃|本月活跃|在线|刚刚)/;
    // 严格姓名形态：X女士/X先生/老师、拉丁昵称、或 2-4 字中文（且需与职位 token 相邻才有效）
    const isNameTk = (tk) =>
      !BAD.test(tk) &&
      (/^[\u4e00-\u9fa5]{1,3}(?:女士|先生|老师)$/.test(tk) ||
        /^[A-Za-z][A-Za-z0-9._-]{1,15}$/.test(tk) ||
        /^[\u4e00-\u9fa5]{2,4}$/.test(tk));
    const tokensOf = (t) =>
      String(t || '').split(/[·|｜\s]+/).map((s) => s.trim()).filter(Boolean);
    const scanTokens = (tokens) => {
      let active = '';
      for (const tk of tokens) if (!active && ACTIVE_RE.test(tk) && tk.length <= 8) active = tk;
      // 姓名必须与职位 token 相邻，避免把“招聘中/最新”等状态标签误当人名（上一版的真实故障）
      for (let i = 0; i < tokens.length; i++) {
        if (!(TITLE_RE.test(tokens[i]) && tokens[i].length <= 12)) continue;
        for (const j of [i - 1, i + 1, i - 2, i + 2]) {
          const tk = tokens[j];
          if (tk && isNameTk(tk)) return { hr: tk, hrTitle: tokens[i], hrActive: active };
        }
      }
      return { hr: '', hrTitle: '', hrActive: active };
    };

    const best = { hr: '', hrTitle: '', hrActive: '' };
    const areas = [
      root.querySelector('[class*="job-detail-op"]'),
      root.querySelector('.job-banner'),
      root.querySelector('[class*="boss-info"]')
    ].filter(Boolean);
    for (const area of areas) {
      const r = scanTokens(tokensOf(area.innerText || area.textContent || ''));
      if (!best.hrActive && r.hrActive) best.hrActive = r.hrActive;
      if (r.hr) return r;
    }
    for (const el of root.querySelectorAll('[class*="boss"], [class*="publish"], [class*="poster"]')) {
      const r = scanTokens(tokensOf(el.innerText || el.textContent || ''));
      if (!best.hrActive && r.hrActive) best.hrActive = r.hrActive;
      if (r.hr) return r;
    }
    // 终极兜底：全文档扫描“X女士/X先生/老师”叶子元素（严格称谓模式，无需职位相邻）
    for (const el of root.querySelectorAll('span,div,a,p,em,b,i')) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 24 || BAD.test(t)) continue;
      const mHr = t.match(/^[\u4e00-\u9fa5A-Za-z]{1,6}(?:女士|先生|老师)/);
      if (!mHr) continue;
      const mTi = t.match(TITLE_RE);
      best.hr = cleanHR(mHr[0]);
      best.hrTitle = mTi ? mTi[0] : '';
      break;
    }
    return best;
  }

  function extractDetail(doc) {
    const root = doc.documentElement || doc;
    const pick = (sels) => {
      for (const s of sels) {
        const el = root.querySelector(s);
        if (el && txt(el)) return el;
      }
      return null;
    };
    let jdEl = pick(SEL_DETAIL.jd);
    let jd = blockText(jdEl);
    if (!jd) {
      // 兜底：找包含 JD 关键词的文本块
      const blocks = Array.from(root.querySelectorAll('div,section')).filter(
        (e) => e.textContent && e.textContent.length > 120
      );
      const kw = blocks.find(
        (e) =>
          /岗位职责|工作职责|职位描述|任职要求|工作内容/.test(e.textContent) &&
          e.children.length < 8
      );
      if (kw) jd = blockText(kw);
    }
    const salaryEl = pick(SEL_DETAIL.salary);
    const areaEl = pick(SEL_DETAIL.area);
    const welfare = qsa(SEL_DETAIL.welfare, root).map(txt).filter(Boolean).join('、');
    const compEl = pick(SEL_DETAIL.companyBlock);
    const hrInfo = extractHRInfo(root);
    // 公司信息块保留换行，供后台按 token 解析公司名/行业/规模/融资
    const raw = compEl ? String(compEl.innerText || compEl.textContent || '') : '';
    return {
      jd: jd.slice(0, 5000),
      salary: salaryEl ? txt(salaryEl) : '',
      welfare,
      area: areaEl ? txt(areaEl) : '',
      hr: hrInfo.hr,
      hrTitle: hrInfo.hrTitle,
      hrActive: hrInfo.hrActive || '',
      companyRaw: raw.replace(/[ \t\u00a0]+/g, ' ').trim()
    };
  }

  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { credentials: 'include', signal: ctrl.signal })
      .finally(() => clearTimeout(timer));
  }

  function iframeDetail(link) {
    return new Promise((resolve) => {
      let done = false;
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:900px;';
      const finish = (v) => {
        if (done) return;
        done = true;
        try { f.remove(); } catch (e) { /* ignore */ }
        resolve(v);
      };
      f.onload = () => {
        setTimeout(() => {
          try {
            const d = extractDetail(f.contentDocument);
            finish(Object.assign({ via: 'iframe' }, d));
          } catch (e) {
            finish({ jd: '', salary: '', welfare: '', via: 'fail' });
          }
        }, 2200); // 等待客户端渲染（HR/活跃度区块是 JS 注入的）
      };
      f.src = link;
      document.body.appendChild(f);
      setTimeout(() => finish({ jd: '', salary: '', welfare: '', via: 'timeout' }), 20000);
    });
  }

  async function fetchJobDetail(link) {
    if (!link) return { jd: '', salary: '', welfare: '', via: 'no-link' };
    // 1) fetch + DOMParser（详情页是服务端渲染，HTML 里就有 JD）
    try {
      const res = await fetchWithTimeout(link, CONFIG.detailTimeout);
      if (res.ok) {
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const d = extractDetail(doc);
        if (d.jd) return Object.assign({ via: 'fetch' }, d);
      }
    } catch (e) { /* 被风控拦截或超时，走 iframe 兜底 */ }
    // 2) 同源 iframe 兜底
    return iframeDetail(link);
  }

  /* ================= JD 批量补全 ================= */
  let enriching = false;
  let enrichAborted = false;
  let jdConcurrency = 1;

  async function getConcurrency() {
    try {
      const resp = await ask({ type: 'GET_CONCURRENCY' });
      if (resp && resp.concurrency) jdConcurrency = Math.max(1, Math.min(6, resp.concurrency | 0));
    } catch (e) { /* 后台休眠等异常时沿用当前值 */ }
    return jdConcurrency;
  }

  async function enrichOne(resp, slow) {
    if (enrichAborted) return;
    const d = await fetchJobDetail(resp.job.link);
    if (enrichAborted) return;
    // HR 姓名/职位是客户端渲染，fetch 到的 HTML 里没有：用渲染后的 iframe 二次补取
    if (!d.hr && d.via === 'fetch') {
      const r2 = await iframeDetail(resp.job.link);
      if (!enrichAborted) {
        d.hr = d.hr || r2.hr || '';
        d.hrTitle = d.hrTitle || r2.hrTitle || '';
        d.hrActive = d.hrActive || r2.hrActive || '';
        d.area = d.area || r2.area || '';
        if (!d.welfare && r2.welfare) d.welfare = r2.welfare;
      }
    }
    if (FontDecoder.isPUA(d.salary) || FontDecoder.isPUA(d.jd)) {
      await FontDecoder.init(null);
      d.salary = FontDecoder.decodeText(d.salary);
      d.jd = FontDecoder.decodeText(d.jd);
    }
    fire({ type: 'JD_RESULT', key: resp.job.key, detail: d });
    // 失败退避：请求异常/超时后额外多等一会，降低连击触发风控的概率
    if (d.via === 'fail' || d.via === 'timeout') await sleep(2500 + Math.random() * 2000);
    await sleep(slow ? 700 + Math.random() * 900 : 300 + Math.random() * 300);
  }

  // 并发池：n 个 worker 各自领任务→抓取→上报；后台领任务时同步标记 detailFetching，天然防重复
  async function runEnrichPool(budgetMs, t0) {
    const n = await getConcurrency();
    const worker = async (first) => {
      for (;;) {
        if (enrichAborted) return;
        if (budgetMs && Date.now() - t0 > budgetMs - 600) return;
        const resp = await ask({ type: 'GET_NEXT_PENDING' });
        if (!resp) { if (first) report('WARN', '与后台连接中断，JD获取已暂停'); return; }
        if (!resp.job) return;
        if (first && !budgetMs && resp.pending % 10 === 0)
          report('ENRICH', `获取JD详情（剩 ${resp.pending} 条）：${resp.job.name}`);
        await enrichOne(resp, !budgetMs);
      }
    };
    const ws = [];
    for (let i = 0; i < n; i++) ws.push(worker(i === 0));
    await Promise.all(ws);
  }

  // 翻页等待期间穿插JD补全，充分利用时间窗
  async function delayWithEnrich() {
    const budget = CONFIG.pageDelay[0] + Math.random() * (CONFIG.pageDelay[1] - CONFIG.pageDelay[0]);
    const t0 = Date.now();
    await runEnrichPool(budget, t0);
    const left = budget - (Date.now() - t0);
    if (left > 0) await sleep(left);
  }

  async function enrichAll(concurrency) {
    if (enriching) return;
    enriching = true;
    enrichAborted = false;
    if (concurrency) jdConcurrency = Math.max(1, Math.min(6, concurrency | 0));
    try {
      await runEnrichPool(0);
      if (!enrichAborted) report('DONE', 'JD详情全部获取完成 ✔ 可点击"导出CSV"');
    } catch (e) {
      report('WARN', 'JD获取中断：' + (e && e.message));
    }
    enriching = false;
  }

  /* ================= 主流程 ================= */
  let running = false;

  async function begin() {
    if (running) return;
    running = true;
    let pageNo = 1;
    try {
      while (running) {
        report('RUN', `第 ${pageNo} 页：等待岗位列表渲染…`);
        const w = await waitCards(CONFIG.cardWaitTimeout);
        if (!w.ok) {
          if (w.captcha) {
            report('WAIT_CAPTCHA', '检测到安全验证，请在页面上手动完成，完成后自动继续…');
            if (await waitCaptchaGone()) continue;
            report('ERROR', '等待安全验证超时，已停止');
          } else {
            report('ERROR', '未找到岗位列表：请确认已登录，且当前页面是职位搜索结果页');
          }
          break;
        }

        report('RUN', `第 ${pageNo} 页：逐屏读取岗位数据（够数即停）…`);
        const res = await collectPageIncrementally();
        if (res === 'STOPPED') break; // 达标/手动停止，状态由后台展示

        report('RUN', `第 ${pageNo} 页已读完，准备翻页…`);
        const moved = await gotoNextPage();
        if (!moved) {
          fire({ type: 'EXHAUSTED' }); // 交给后台：切换下一个搜索词或收尾补全
          break;
        }
        pageNo++;
        await delayWithEnrich(); // 翻页等待期间穿插JD补全
      }
    } catch (e) {
      report('ERROR', '运行出错：' + (e && e.message));
    }
    running = false;
    fire({ type: 'LOOP_END' });
  }

  /* ================= 消息入口 ================= */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START') {
      enrichAborted = false;
      begin();
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP') {
      running = false;
      enrichAborted = true; // 同步中断JD补全
      sendResponse({ ok: true });
    } else if (msg.type === 'START_ENRICH') {
      enrichAll(msg.concurrency);
      sendResponse({ ok: true });
    } else if (msg.type === 'PING') {
      sendResponse({ ok: true, cards: findCards().length });
    }
    return false;
  });

  // 页面加载后：若后台任务正在进行且本标签页就是任务页，则自动继续（应对中途刷新/跳转）
  try {
    chrome.runtime.sendMessage({ type: 'IS_RUNNING' }, (resp) => {
      if (resp && resp.running) begin();
    });
  } catch (e) { /* ignore */
  }
})();
