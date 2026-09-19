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

  /* ================= 平台检测 =================
   * 同一份 content.js 跑在两个站点上：
   *  - boss：BOSS直聘（无限滚动 SPA + 详情页安检跳转 + 薪资字体加密）
   *  - sx  ：实习僧（MPA 分页 20条/页 + 列表页薪资/天数/月数/规模字体加密，
   *          详情页字段明文，无需解密）
   */
  const PLATFORM = /(^|\.)shixiseng\.com$/.test(location.hostname) ? 'sx' : 'boss';
  const IS_SX = PLATFORM === 'sx';

  /* ================= 可配置参数 ================= */
  const CONFIG = {
    pageDelay: [6000, 13000],   // 翻页之间随机停留区间（毫秒）。过快会触发 IP 风控
    scrollDelay: 350,           // 滚动步进间隔（毫秒）
    cardWaitTimeout: 20000,     // 等待岗位卡片渲染的超时
    pageChangeTimeout: 15000,   // 翻页后等待列表变化的超时
    captchaWaitTimeout: 180000, // 等待人工完成安全验证的超时
    maxScrollSteps: 60,         // 单页最大滚动步数
    detailTimeout: 8000,        // 详情页 fetch 超时（正常页几百ms返回；挂死时快速放弃）
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
    next: ['a[ka="page-next"]', '[ka="page-next"]', '.page-next', '.ui-icon-arrow-page-next']
  };

  /* ====== 实习僧选择器（基于真实页面快照验证，见 CHANGELOG v2.0.0）======
   * 列表卡片：div.intern-item[data-intern-id="inn_xxx"]，每页20条，
   * Element-UI 标准分页（el-pagination）+ ?page=N URL 跳页。
   * 加密字体元素带 .font 类（字体 myFont，/interns/iconfonts/file?rand= 动态加载），
   * 详情页字段全部明文，无需解密。
   */
  const SEL_SX = {
    card: ['div.intern-item[data-intern-id]', '.intern-wrap.intern-item'],
    jobLink: ['a.title[href*="/intern/"]', 'a[href*="/intern/"]'],
    salary: ['.day.font', '.day'],
    city: ['.city.ellipsis', '.city'],
    tipFonts: ['.intern-detail__job .tip .font'],
    company: ['.intern-detail__company a.title'],
    companyTip: ['.intern-detail__company .tip span'],
    welfare: ['.intern-label'],
    pagerNext: ['.el-pagination .btn-next'],
    pager: ['.el-pagination .el-pager']
  };

  /* ====== 实习僧详情页选择器（字段均为明文）====== */
  const SEL_SX_DETAIL = {
    name: ['.new_job_name'],
    jd: ['.job_detail'],
    salary: ['.job_money'],
    area: ['.job_position'],
    education: ['.job_academic'],
    week: ['.job_week'],
    experience: ['.job_time'],       // 实习3个月
    date: ['.job_date'],
    welfare: ['.job_good_list span'],
    comPosition: ['.com_position'],  // 湖北省/武汉市/武昌区 公司名
    company: ['.com-name'],
    deadline: ['.con-job .cutom_font'] // 截止日期：20XX-XX-XX
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

  /* ====== SPA 无限滚动适配 ======
   * BOSS 搜索页已是纯前端渲染的无限滚动列表（无"下一页"按钮，内容随滚动懒加载）。
   * 滚动可能发生在 window 或内部容器（overflow:auto），必须找准真正的滚动主体；
   * 到底后需等待 AJAX 追加新卡片，不能立即判定到底/采尽 */
  const IS_WINDOW_SCROLLER = (el) =>
    !el || el === document.scrollingElement || el === document.documentElement || el === document.body;

  function findScrollContainer() {
    const anchor = findCards()[0];
    const cands = [];
    try {
      document.querySelectorAll('div,main,section,ul').forEach((el) => {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 200) cands.push(el);
      });
    } catch (e) { /* ignore */ }
    if (anchor) {
      for (const el of cands) if (el.contains(anchor)) return el;
    }
    return null; // 无内部滚动容器 → 滚 window
  }

  function scrollStep(el) {
    // 轻推：小幅随机滚动，用于到底后促进懒加载触发
    const d = 60 + Math.random() * 160;
    if (IS_WINDOW_SCROLLER(el)) {
      window.scrollBy(0, d);
    } else {
      try { el.scrollTop += d; } catch (e) { /* ignore */ }
    }
    try { window.dispatchEvent(new Event('scroll')); } catch (e) { /* ignore */ }
  }

  // 拟人滚动手势：一次滚轮 = 带缓动衰减的若干微步（先快后慢，模拟动量）；
  // 幅度随机：多数 200~650px，偶发大滑 800~1400px，偶发小碎步 60~160px。
  // 每次手势后合成派发 scroll 事件——【实测关键】隐藏标签页渲染冻结，
  // 真实滚动事件永不触发，BOSS 的懒加载器靠它唤醒；到底时先上滚再下滚
  // 保证位置变化 + 哨兵重入（否则加载器再也不触发）
  async function humanScrollOnce(el) {
    const wasBottom = atBottom(el);
    if (wasBottom) {
      // 到底时先上滚：位置不变不会产生滚动事件，哨兵也不会重入，加载器会饿死
      if (IS_WINDOW_SCROLLER(el)) window.scrollBy(0, -400);
      else { try { el.scrollTop -= 400; } catch (e) { /* ignore */ } }
      await sleep(80 + Math.random() * 120);
    }
    const r = Math.random();
    const dist =
      r < 0.08 ? 800 + Math.random() * 600 :
      r < 0.2 ? 60 + Math.random() * 100 :
      200 + Math.random() * 450;
    const steps = 4 + Math.floor(Math.random() * 7);
    let done = 0;
    for (let s = 0; s < steps; s++) {
      const remain = dist - done;
      if (remain <= 0) break;
      const frac = (s + 1) / steps;
      const delta = Math.max(2, Math.round((remain * (1 - frac * 0.55)) / (steps - s)));
      done += delta;
      if (IS_WINDOW_SCROLLER(el)) {
        window.scrollBy(0, delta);
      } else {
        try { el.scrollTop += delta; } catch (e) { /* ignore */ }
      }
      await sleep(20 + Math.random() * 45); // 微步间隔
    }
    try { window.dispatchEvent(new Event('scroll')); } catch (e) { /* ignore */ }
  }

  function atBottom(el) {
    if (IS_WINDOW_SCROLLER(el)) return window.innerHeight + window.scrollY >= pageHeight() - 60;
    try { return el.scrollTop + el.clientHeight >= el.scrollHeight - 60; } catch (e) { return true; }
  }

  // 到底后等待懒加载追加新卡片（SPA 加载中卡片数会增长）；
  // 轻推节拍也拟人化：0.7~1.6s 随机间隔，不匀速
  async function waitCardsGrow(before, timeoutMs, scroller) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(700 + Math.random() * 900);
      if (findCards().length > before) return true;
      scrollStep(scroller);
    }
    return findCards().length > before;
  }

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

    async function init(salaryEl, sampleSel) {
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

          // 2) 采样 PUA 加密字符（采样范围按平台传入：BOSS=薪资元素，实习僧=列表内 .font 元素）
          const samples = [];
          const els = salaryEl ? [salaryEl] : Array.from(document.querySelectorAll(sampleSel || '.salary, .job-salary')).slice(0, 6);
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
    let cards = qsa(IS_SX ? SEL_SX.card : SEL.card);
    if (cards.length > 1) {
      cards = cards.filter((c) => !cards.some((o) => o !== c && c.contains(o)));
    }
    return cards;
  }

  // 实习僧列表卡片解析（选择器/字段结构均经真实页面快照验证）
  // 注意：名称/薪资/天数/月数/规模可能含加密字形（_pua 字段标记），
  // 解密在 parseCardAsync 中完成后才提取经验/规模，否则正则匹配不到数字
  function parseCardSx(card) {
    try {
      const id = card.getAttribute('data-intern-id') || '';
      const a = qsOne(SEL_SX.jobLink, card) || card.querySelector('a[href]');
      let link = '';
      if (a) {
        try { link = new URL(a.getAttribute('href'), location.origin).href; } catch (e) { /* ignore */ }
      }
      if (!link && id) link = `${location.origin}/intern/${id}`;
      // 优先 textContent（text 节点实体已被解析器解码为真实 PUA 字符）；
      // title 属性在源码中被双重转义，取到的是 "&#xf040" 形式的字面文本，无法解密
      const nameEl = card.querySelector('a.title');
      const name = (nameEl && txt(nameEl)) || (nameEl ? nameEl.getAttribute('title') : '') || '';
      const salary = txt(qsOne(SEL_SX.salary, card));          // 加密数字 + /天
      const city = txt(qsOne(SEL_SX.city, card));
      // tip 行加密字体：['X天/周', 'Y个月']（数字为 PUA，待解密）
      const tipFonts = qsa(SEL_SX.tipFonts, card).map(txt);
      const companyEl = qsOne(SEL_SX.company, card);
      const company = companyEl ? companyEl.getAttribute('title') || txt(companyEl) : '';
      const compSpans = qsa(SEL_SX.companyTip, card).map(txt).filter((s) => s && s !== '/');
      const industry = compSpans.find((s) => /\//.test(s)) || '';
      const scale = compSpans.find((s) => /人/.test(s)) || '';
      const welfare = qsa(SEL_SX.welfare, card)
        .map((x) => x.getAttribute('title') || txt(x))
        .filter(Boolean)
        .join('、');
      return {
        name, salary, area: city, experience: '', education: '', skills: '',
        welfare, company, industry, scale, funding: '',
        link, platform: 'sx',
        _sxTipFonts: tipFonts // 私有字段：解密后提取实习时长，入库前删除
      };
    } catch (e) {
      return null;
    }
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

      return {
        name, salary, area, experience, education, skills,
        company, industry, scale, funding,
        link
      };
    } catch (e) {
      return null;
    }
  }

  let decodeWarned = false;
  async function parseCardAsync(card) {
    const j = IS_SX ? parseCardSx(card) : parseCard(card);
    if (!j) return null;
    // 实习僧列表页的名称/薪资/天数/月数/规模都可能含加密字形；详情页为明文，
    // JD 补全时会用明文覆盖，这里的解密只是提前可用
    if (FontDecoder.isPUA(j.salary) || FontDecoder.isPUA(j.name) || (j._sxTipFonts || []).some(FontDecoder.isPUA)) {
      const ok = await FontDecoder.init(
        IS_SX ? qsOne(SEL_SX.salary, card) : qsOne(SEL.salary, card),
        IS_SX ? '.intern-item .font' : null
      );
      j.salary = FontDecoder.decodeText(j.salary); // 解密不可用时以□占位，避免隐形乱码
      j.name = FontDecoder.decodeText(j.name);
      j.scale = FontDecoder.decodeText(j.scale);
      if (j._sxTipFonts) {
        // 解密后再提取实习时长（PUA 字形不是 \d，解密前正则匹配不到数字）
        const fonts = j._sxTipFonts.map(FontDecoder.decodeText);
        const months = (fonts.find((s) => /个月/.test(s)) || '').match(/(\d+)\s*个月/);
        if (months) j.experience = `实习${months[1]}个月`;
        delete j._sxTipFonts;
      }
      if (!ok && !decodeWarned) {
        decodeWarned = true;
        report('WARN', '部分数字为加密字体且自动解密未成功，对应数字将以□显示（JD补全后会被详情页明文覆盖）');
      }
    } else if (j._sxTipFonts) {
      delete j._sxTipFonts;
    }
    return j;
  }

  /* ================= 逐屏增量采集（够数即停） ================= */
  /* ================= 列表采集：单步模式（由后台闹钟 LIST_STEP 驱动） =================
   * 【实测依据】（_bg_scroll_test.js / _bg_probe2.js，headless Chrome + intensive 节流）
   * 1. 隐藏标签页中 350~600ms 链式定时器被 intensive 节流到 ~1次/分：自驱动循环
   *    几步内就误判采尽假死（3 次手势即停）→ 任务停在几十条；
   * 2. 隐藏页 scrollY 会变但 scroll 事件永不触发（由冻结的渲染管线派发）→
   *    BOSS 懒加载器饿死 → 必须每步后合成派发 scroll 事件唤醒；
   * 3. 到底时需先上滚再下滚（位置不变无事件、哨兵不重入）；
   * 4. 后台 Runtime 驱动的单步不受页面定时器节流（30 手势/分 vs 1/分）。
   * 因此采集循环迁入后台闹钟状态机，页面只提供“一步”原语。
   */
  const seenJobs = new Set();
  function resetSeenJobs() { seenJobs.clear(); }

  async function grabVisible() {
    const fresh = [];
    for (const c of findCards()) {
      const j = await parseCardAsync(c);
      if (!j) continue;
      const k = j.link || `${j.name}|${j.company}|${j.salary}`;
      if (seenJobs.has(k)) continue;
      seenJobs.add(k);
      fresh.push(j);
    }
    if (fresh.length) {
      fire({ type: 'BATCH', jobs: fresh });
      await sleep(250);
    }
    return fresh.length;
  }

  // 单步初始化（幂等）：跳页落地守卫。返回 null=正常 / 'exhausted'=跳页未生效判采尽
  let initDone = false;
  let jumpCheck = null; // { prevFirst } 跳页后首卡内容校验

  /* ================= 安全验证判定 ================= */
  // v2.0.2 起改为按 URL/页面特征判定，不再嗅探验证组件元素：
  // 实测站点会预载隐藏的验证 SDK 面板（如极验 geetest 常驻 DOM，且可能以
  // "移出视口"方式隐藏，宽高/可见性检查无法识别），元素嗅探必然误报。
  // BOSS 的验证只以独立页面形式出现（滑块 /web/user/verify、被动安检
  // /web/common/security-check），URL 判定零误报；其它站点用
  // "极小页面 + 明确验证文案"兑底，正常列表/详情页永远不满足。
  function detectCaptcha() {
    try {
      const url = location.href || '';
      if (/zhipin\.com\/web\/user\/verify/i.test(url)) return 'BOSS滑块验证页';
      if (/zhipin\.com\/web\/common\/security-check/i.test(url)) return 'BOSS安检页（通常数秒自动通过）';
      const bt = String((document.body && document.body.innerText) || '').replace(/\s+/g, '');
      if (bt && bt.length < 120 && /拖动滑块|滑块验证|安全验证|完成拼图|行为验证|验证码/.test(bt)) {
        return '验证过渡页：' + bt.slice(0, 30);
      }
      return '';
    } catch (e) {
      return '';
    }
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
      const cap = detectCaptcha();
      if (cap) return { ok: false, captcha: cap };
      if (findCards().length) return { ok: true };
      await sleep(800);
    }
    return { ok: false, captcha: detectCaptcha() };
  }

  /* ================= 翻页 ================= */
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

  // 当前页码（从 URL 提取，跨导航准确）
  function curPageNo() {
    try {
      return parseInt(new URL(location.href).searchParams.get('page'), 10) || 1;
    } catch (e) {
      return 1;
    }
  }

  // 实习僧翻页：URL 跳页为主（SSR MPA，与手点同效）；btn-next 置灰 = 最后一页
  async function gotoNextPageSx() {
    const btn = qsOne(SEL_SX.pagerNext);
    if (btn && btn.disabled) {
      report('RUN', '已是最后一页，本搜索词采尽');
      return false;
    }
    if (!btn && !qsOne(SEL_SX.pager)) {
      // 页面无分页控件（异常/无结果页）：交由后台处理
      return false;
    }
    const before = firstCardKey();
    const next = curPageNo() + 1;
    try {
      sessionStorage.setItem('__boss_prev_first', before || '');
      sessionStorage.setItem('__boss_next_page', String(next));
      const u = new URL(location.href);
      u.searchParams.set('page', String(next));
      location.href = u.toString();
      await sleep(3000); // 导航生效则页面卸载，走不到这里
    } catch (e) { /* ignore */ }
    return false;
  }

  async function gotoNextPage() {
    if (IS_SX) return gotoNextPageSx();
    const before = firstCardKey();
    const btn = findNextButton();

    // BOSS 搜索页已是无限滚动 SPA：无分页按钮属正常（页面滚动已由后台闹钟单步
    // 驱动 humanScrollOnce 完成），这里直接如实报告，交由后台切换下一搜索词
    if (!btn) {
      report('RUN', '当前为无限滚动列表且已滚动到底（无更多新内容），本搜索词采尽');
      return false;
    }

    // 以下为传统分页（MPA）兑底：BOSS 若对部分列表保留"下一页"按钮则仍可用
    if (!isDisabled(btn)) {
      btn.click();
      const t0 = Date.now();
      while (Date.now() - t0 < CONFIG.pageChangeTimeout) {
        await sleep(700);
        const cap = detectCaptcha();
        if (cap) {
          report('WAIT_CAPTCHA', '检测到安全验证（' + cap + '），请在页面上手动完成…');
          await waitCaptchaGone();
        }
        const now = firstCardKey();
        if (now && now !== before) {
          window.scrollTo(0, 0);
          return true;
        }
      }
      report('WARN', `点击下一页无反应（等待 ${Math.round(CONFIG.pageChangeTimeout / 1000)}s 内容未变化），改用直接跳转第 ${curPageNo() + 1} 页…`);
    } else {
      report('RUN', '"下一页"按钮已置灰，本搜索词采尽');
      return false;
    }

    // 点击无反应时的兑底：按页码直接跳 URL（同标签页导航，与手点无异）
    try {
      sessionStorage.setItem('__boss_prev_first', before || '');
      sessionStorage.setItem('__boss_next_page', String(curPageNo() + 1));
      const u = new URL(location.href);
      u.searchParams.set('page', String(curPageNo() + 1));
      location.href = u.toString();
      await sleep(3000); // 导航生效则页面卸载，走不到这里
      return false;
    } catch (e) {
      return false;
    }
  }

  /* ================= JD 详情获取 ================= */
  /* ================= 详情页字段提取 ================= */
  // 实习僧详情页：字段全部明文（快照验证），直接选择器命中；JD 多层降级同 BOSS
  function extractDetailSx(root) {
    const pick1 = (sels) => {
      for (const s of sels) {
        const el = root.querySelector(s);
        if (el && txt(el)) return el;
      }
      return null;
    };
    // JD 多层降级（与 BOSS 同架构，选择器换成实习僧）
    let jd = '';
    let jdVia = '';
    const valid = (t) => t && t.length >= 50;
    const layer = (name, fn) => {
      if (valid(jd)) return;
      try {
        fn();
        if (valid(jd)) jdVia = name;
      } catch (e) { /* ignore */ }
    };
    layer('层1选择器', () => {
      const el = pick1(SEL_SX_DETAIL.jd);
      if (el) jd = blockText(el);
    });
    layer('层2容器拼接', () => {
      const scope = root.querySelector('.content_left .con-job');
      if (scope) jd = blockText(scope);
    });
    layer('层3关键词', () => {
      const cands = [];
      for (const e of root.querySelectorAll('div,section')) {
        const t = e.textContent || '';
        if (t.length < 60 || t.length > 6000) continue;
        const hits = (t.match(/岗位职责|工作职责|职位描述|任职要求|工作内容|任职资格|岗位要求|职责|工作要求/g) || []).length;
        if (hits) cands.push({ e, t, hits });
      }
      cands.sort((a, b) => (b.hits - a.hits) || (a.t.length - b.t.length));
      if (cands.length) jd = blockText(cands[0].e);
    });

    const money = pick1(SEL_SX_DETAIL.salary);
    const eduEl = pick1(SEL_SX_DETAIL.education);
    const expEl = pick1(SEL_SX_DETAIL.experience);   // 实习3个月
    const weekEl = pick1(SEL_SX_DETAIL.week);        // 5天／周
    const comPosEl = pick1(SEL_SX_DETAIL.comPosition);
    // com_position 文本 = "湖北省/武汉市/武昌区 公司名（多 token）"：首 token（含/）为地区，其余为公司名
    let area = '';
    let comFromPos = '';
    const cp = comPosEl ? String(comPosEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const cpM = cp.match(/^(\S*)\s+(.+)$/);
    if (cpM) { area = cpM[1]; comFromPos = cpM[2]; }
    const company = (pick1(SEL_SX_DETAIL.company) || {}).textContent
      ? txt(pick1(SEL_SX_DETAIL.company))
      : comFromPos;
    const welfare = [...new Set(qsa(SEL_SX_DETAIL.welfare, root).map(txt).filter(Boolean))].join('、');
    const dateRaw = pick1(SEL_SX_DETAIL.date);
    const deadline = pick1(SEL_SX_DETAIL.deadline);
    // 把额外信息收进 companyRaw（保留换行），供后台按 token 解析
    const raw = [
      company,
      eduEl ? '学历要求 ' + txt(eduEl) : '',
      expEl ? txt(expEl) : '',
      weekEl ? txt(weekEl) : '',
      deadline ? txt(deadline) : '',
      dateRaw ? '发布于 ' + txt(dateRaw) : ''
    ].filter(Boolean).join('\n');
    return {
      jd: String(jd || '').slice(0, 5000),
      jdVia,
      name: (() => { const el = pick1(SEL_SX_DETAIL.name); return el ? txt(el) : ''; })(),
      salary: money ? txt(money) : '',
      welfare,
      area,
      education: eduEl ? txt(eduEl) : '',
      experience: expEl ? txt(expEl) : '',
      companyRaw: raw
    };
  }

  function extractDetail(doc) {
    if (IS_SX) return extractDetailSx(doc.documentElement || doc);
    const root = doc.documentElement || doc;
    const pick = (sels) => {
      for (const s of sels) {
        const el = root.querySelector(s);
        if (el && txt(el)) return el;
      }
      return null;
    };
    // —— JD 提取（多层降级，每层结果需通过有效性检查才采纳）——
    let jd = '';
    let jdVia = ''; // 命中层级（诊断用）
    const valid = (t) => t && t.length >= 50;
    // 每层独立隔离：单层异常只跳过该层，绝不殃及其余层
    // （真实DOM测试暴露：四层共用一个try时，单层抛异常会让JD全空）
    const layer = (name, fn) => {
      if (valid(jd)) return;
      try {
        fn();
        if (valid(jd)) jdVia = name;
      } catch (e) { /* 忽略单层异常 */ }
    };

    layer('层1容器拼接', () => {
      // 层1：圈定 JD 模块容器 → 全部分块按文档序去重拼接（职责/任职要求分块不漏）
      const scope =
        root.querySelector('[class*="job-desc"]') ||
        root.querySelector('.job-detail-section') ||
        root.querySelector('.detail-content');
      if (!scope) return;
      const blocks = [];
      for (const s of SEL_DETAIL.jd) {
        qsa([s], scope).forEach((el) => {
          const t = (el.textContent || '').trim();
          if (t.length > 15) blocks.push(el);
        });
      }
      const leaves = blocks.filter((el) => !blocks.some((o) => o !== el && el.contains(o)));
      leaves.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      );
      const parts = [];
      for (const el of leaves) {
        const t = blockText(el);
        if (t && !parts.includes(t)) parts.push(t);
      }
      jd = parts.join('\n');
      if (!valid(jd)) jd = blockText(scope);
    });

    layer('层2选择器', () => {
      // 层2：老式直接命中（容器类名改版时仍可能命中分块本身）
      const el = pick(SEL_DETAIL.jd);
      if (el) jd = blockText(el);
    });

    layer('层3关键词', () => {
      // 层3：关键词定位（不限 class，找包含职责/要求等关键词的最紧凑文本块）
      const cands = [];
      for (const e of root.querySelectorAll('div,section')) {
        const t = e.textContent || '';
        if (t.length < 60 || t.length > 6000) continue;
        const hits = (t.match(/岗位职责|工作职责|职位描述|任职要求|工作内容|任职资格|岗位要求|职责|工作要求/g) || []).length;
        if (hits) cands.push({ e, t, hits });
      }
      cands.sort((a, b) => (b.hits - a.hits) || (a.t.length - b.t.length));
      if (cands.length) jd = blockText(cands[0].e);
    });

    layer('层4兜底', () => {
      // 层4：最后兜底——取最大的 200~4500 字文本块（JD 通常是页面主内容区），
      // 但必须含岗位词汇，防止把导航/页脚等噪声当 JD
      let best = null;
      let bestLen = 0;
      for (const e of root.querySelectorAll('div,section')) {
        const t = (e.textContent || '').trim();
        if (t.length < 200 || t.length > 4500 || t.length <= bestLen) continue;
        if (/职责|任职|负责|熟悉|优先|经验|岗位/.test(t)) { best = e; bestLen = t.length; }
      }
      if (best) jd = blockText(best);
    });

    const salaryEl = pick(SEL_DETAIL.salary);
    const areaEl = pick(SEL_DETAIL.area);
    const welfare = [...new Set(qsa(SEL_DETAIL.welfare, root).map(txt).filter(Boolean))].join('、');
    const compEl = pick(SEL_DETAIL.companyBlock);
    // 公司信息块保留换行，供后台按 token 解析公司名/行业/规模/融资
    const raw = compEl ? String(compEl.innerText || compEl.textContent || '') : '';
    return {
      jd: String(jd || '').slice(0, 5000),
      jdVia,
      salary: salaryEl ? txt(salaryEl) : '',
      welfare,
      area: areaEl ? txt(areaEl) : '',
      companyRaw: raw.replace(/[ \t\u00a0]+/g, ' ').trim()
    };
  }

  // 页面内提取（由后台导航到详情页后调用）：轮询等水合，最多8s；
  // 成功/失败都输出诊断（控制台可 F12 查看）
  async function extractDetailTab() {
    const t0 = Date.now();
    for (;;) {
      let d;
      try {
        d = extractDetail(document);
      } catch (e) {
        d = { jd: '', salary: '', welfare: '', area: '', companyRaw: '' };
      }
      // IP 级封禁页检测：标题仍是"BOSS直聘"，只能看正文特征。
      // 必须立即上报停止重试——封禁期间继续请求只会延长封禁
      const bodyNow = (document.body && document.body.innerText) || '';
      if (/访问受限|IP\s*存在异常|暂时被禁止访问|访问异常|请求过于频繁/.test(bodyNow)) {
        const diag = {
          src: 'tab', title: '访问受限(IP风控)', url: location.href,
          n: bodyNow.length, text: bodyNow.replace(/\s+/g, ' ').slice(0, 120)
        };
        console.log('[BOSS采集器] IP 被限制访问：', diag);
        return Object.assign({ via: 'blocked', ms: Date.now() - t0 }, d, { diag });
      }
      if (d.jd) {
        if (FontDecoder.isPUA(d.salary) || FontDecoder.isPUA(d.jd)) {
          await FontDecoder.init(null);
          d.salary = FontDecoder.decodeText(d.salary);
          d.jd = FontDecoder.decodeText(d.jd);
        }
        console.log(`[BOSS采集器] JD提取成功：${d.jdVia || '?'} · ${d.jd.length}字`);
        return Object.assign({ via: 'tab', ms: Date.now() - t0 }, d);
      }
      if (Date.now() - t0 > 8000) {
        const body = (document.body && document.body.innerText) || '';
        const diag = {
          src: 'tab',
          title: document.title || '',
          url: location.href || '',
          n: body.length,
          text: body.replace(/\s+/g, ' ').slice(0, 120),
          ready: document.readyState,
          jobDesc: document.querySelectorAll('[class*="job-desc"]').length,
          secText: document.querySelectorAll('[class*="job-sec-text"]').length,
          pua: /[\ue000-\uf8ff]/.test(body)
        };
        console.log('[BOSS采集器] JD提取失败诊断：', diag);
        return Object.assign({ via: 'tab', ms: Date.now() - t0 }, d, { diag });
      }
      await sleep(500);
    }
  }

  // 风控拦截页识别：只看高置信信号（<title> / 最终URL / 状态码）。
  // 不要扫正文与脚本——正常页面的 head 里常含 captcha/geetest 等 SDK 字样，会全部误判
  const BLOCKED_TITLE_RE = /安全验证|验证码|滑动验证|滑块验证|security.?check|请稍候/i;
  function isBlockedDoc(title, url) {
    return BLOCKED_TITLE_RE.test(String(title || '')) || /security-check/i.test(String(url || ''));
  }

  /* ================= 主流程 ================= */
  let running = false;

  /* 列表采集改为后台闹钟驱动的单步模式（LIST_STEP / LIST_ADVANCE）。
   * 【实测依据】（_bg_scroll_test.js，headless Chrome + intensive 节流）：
   * 旧版页面内自驱动循环在隐藏标签页中被定时器节流到 ~1次/分，
   * 几步就误判采尽假死（用户日志：停在 60/1000，“内容脚本已停止”）。
   * 后台 Runtime 驱动的单步不受节流（30 手势/分 vs 1/分）。
   */
  function startRunning() {
    if (!running) {
      running = true;
      initDone = false;
      jumpCheck = null;
      resetSeenJobs();
    }
  }

  // 首步初始化：跳页落地守卫（幂等）。返回 null=正常 / 'exhausted'=跳页未生效判采尽
  async function ensureInit() {
    if (initDone) return null;
    initDone = true;
    resetSeenJobs();
    let jumpWanted = 0;
    let jumpPrevFirst = '';
    try {
      jumpWanted = parseInt(sessionStorage.getItem('__boss_next_page') || '', 10) || 0;
      jumpPrevFirst = sessionStorage.getItem('__boss_prev_first') || '';
      sessionStorage.removeItem('__boss_next_page');
      sessionStorage.removeItem('__boss_prev_first');
      if (jumpWanted && curPageNo() !== jumpWanted) {
        // BOSS 把页码重置了（如该词只有一页，跳第2页被弹回第1页）→ 真采尽
        report('WARN', `跳页未生效（落在第 ${curPageNo()} 页），判定该搜索词已采尽`);
        return 'exhausted';
      }
    } catch (e) { /* ignore */ }
    if (jumpPrevFirst) jumpCheck = { prevFirst: jumpPrevFirst };
    return null;
  }

  function firstCardKey() {
    const cards = findCards();
    if (!cards.length) return '';
    const a = cards[0].querySelector(
      IS_SX ? 'a[href*="/intern/"]' : 'a[href*="/job_detail/"]'
    );
    return a ? a.getAttribute('href') : '';
  }

  // 单步手势 + 抓取（无页内等待：隐藏页的定时器轮询会被节流拖慢，
  // 等待/节奏/重试全部由后台闹钟控制；防重入：上一步未返回前直接 busy）
  let stepBusy = false;
  async function listStep() {
    if (stepBusy) return { busy: true };
    stepBusy = true;
    try {
      const cap = detectCaptcha();
      if (cap) return { captcha: cap, cards: 0, atBottom: false };
      const guard = await ensureInit();
      if (guard === 'exhausted') return { exhausted: true };
      if (!findCards().length) {
        if (/访问受限|暂时被禁止访问/.test((document.body && document.body.innerText) || '')) {
          return { blocked: true };
        }
        return { cards: 0, atBottom: false }; // 首屏未渲染：后台隔步重试
      }
      // 跳页落地内容校验（一次性）：列表与跳页前相同 → 采尽，防死循环
      if (jumpCheck && findCards().length) {
        const nowFirst = firstCardKey();
        const prev = jumpCheck.prevFirst;
        jumpCheck = null;
        if (nowFirst && nowFirst === prev) {
          report('WARN', '跳页后列表内容与上一页相同，判定该搜索词已采尽');
          return { exhausted: true };
        }
      }
      if (IS_SX) {
        // 实习僧 = SSR 翻页列表（Element-UI 分页，20条/页）：卡片已全部渲染，
        // 不做滚动加载；本页抓完直接依据分页控件判定（btn-next 可用=有下一页，
        // 置灰=最后一页），不走 BOSS 无限滚动专用的"到底+3轮无增长"启发式
        const added = await grabVisible();
        const cards = findCards().length;
        const btn = qsOne(SEL_SX.pagerNext);
        if (!btn || btn.disabled || isDisabled(btn)) {
          report('RUN', '已是最后一页（下一页按钮置灰），本搜索词采尽');
          return { exhausted: true, cards, added, page: curPageNo() };
        }
        return { cards, added, atBottom: false, pageDone: true, page: curPageNo() };
      }
      const scroller = findScrollContainer();
      await humanScrollOnce(scroller); // 拟人手势（含合成 scroll 派发唤醒懒加载器）
      const added = await grabVisible();
      return {
        cards: findCards().length,
        added,
        atBottom: atBottom(scroller),
        captcha: detectCaptcha()
      };
    } finally {
      stepBusy = false;
    }
  }


  /* ================= 消息入口 ================= */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START') {
      startRunning(); // 采集循环由后台闹钟驱动，页面只提供单步原语
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP') {
      running = false;
      sendResponse({ ok: true });
    } else if (msg.type === 'PING') {
      sendResponse({ ok: true, cards: findCards().length });
    } else if (msg.type === 'LIST_STEP') {
      // 一步：初始化守卫 + 一次拟人手势 + 抓取可见卡片。不应答超时由后台重建
      listStep()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 160) }));
      return true; // 异步应答
    } else if (msg.type === 'LIST_ADVANCE') {
      // 本页采尽后的翻页原语：点击下一页 / URL 跳页；无按钮 = SPA 已到底（返回 none）
      (async () => {
        try {
          const moved = await gotoNextPage();
          let action = moved ? 'clicked' : 'none';
          if (!moved) {
            try {
              if (sessionStorage.getItem('__boss_next_page')) action = 'jumped';
            } catch (e) { /* ignore */ }
          }
          sendResponse({ ok: true, action });
        } catch (e) {
          sendResponse({ ok: true, action: 'none' });
        }
      })();
      return true;
    } else if (msg.type === 'EXTRACT_DETAIL') {
      // 详情页内的提取请求（后台热标签页通道）
      try {
        extractDetailTab().then((detail) => sendResponse({ detail }));
      } catch (e) {
        sendResponse({
          detail: { jd: '', via: 'error', diag: { src: 'tab', title: '提取异常', url: location.href, n: 0, text: String((e && e.message) || e).slice(0, 120) } }
        });
      }
      return true; // 异步应答
    }
    return false;
  });

  // 页面加载后：若后台任务正在进行且本标签页就是任务页，则自动继续（应对中途刷新/跳转）
  try {
    chrome.runtime.sendMessage({ type: 'IS_RUNNING', platform: PLATFORM }, (resp) => {
      if (resp && resp.running) startRunning();
    });
  } catch (e) { /* ignore */
  }
})();
