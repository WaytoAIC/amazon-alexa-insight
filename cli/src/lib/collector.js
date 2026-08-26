'use strict';
/**
 * 单 ASIN × 单题 的交互与答案捕获。
 *
 * ⚠️ SOURCE OF TRUTH: content/content.js:24-99（选择器）与 :213-480（交互与等待）
 *
 * 与插件的实现关系：
 *  - 选择器常量：原样复制，保留全部兜底候选（含 legacy Rufus）
 *  - findElement/findByText/askQuestion：整段放进 page.evaluate 在页面内执行，
 *    而不是翻译成 Playwright locator 链 —— 保真优先。尤其 askQuestion 必须保留
 *    React native setter + input/change 事件的原方案（Playwright 的 fill() 不等价，
 *    React 受控组件可能收不到变更）。
 *  - waitForNetworkResponse：主路。改成 Node 侧轮询 + 从页面拉流增量，
 *    稳定判定逻辑与 content.js:412-460 同构。
 *  - waitForResponseSmart：DOM 兜底路，同构移植。
 */

const sse = require('./sse-parser.js');

/** content.js:24-99 原样复制 */
const DEFAULT_SELECTORS = {
  rufusBtn: [
    // --- 2026-08 实测：Alexa 已从商品页内嵌组件改为全局导航侧边面板 ✓ ---
    '#nav-rufus-disco',
    '[aria-label*="Open Alexa panel" i]',
    '#nav-flyout-rufus',
    // --- 2026-06 的商品页内嵌组件（当前页面已不存在，保留兜底） ---
    '#dpx-nice-widget-container button.ask-pill',
    'button.small-widget-pill.ask-pill',
    '.ask-pill',
    '[aria-label*="Ask Alexa" i]',
    '[data-csa-c-content-id*="alexa" i]',
    '#rufus-entry-point',
    '[data-csa-c-action="rufus-open"]',
    '.rufus-chat-button',
    'button[aria-label*="Rufus"]',
    '[data-action="rufus"]',
    '#ask-rufus-button',
    '.a-button-rufus',
  ],
  rufusInput: [
    // 2026-08-26 实测（认证后的面板）：提问框仍是稳定 ID #rufus-text-area
    //（placeholder "Ask a shopping question"）。面板里另有一个**隐藏的反馈输入框**
    // #rufus-text-area-inner-N（placeholder "Add your feedback..."），且在 DOM 里排更前 ——
    // 泛化的 `textarea` 选择器会先命中它，把问题打进反馈框。故稳定 ID 必须排在最前，
    // 泛化候选一律带 :not() 排除反馈框。
    '#rufus-text-area',
    '#rufus-container-main-view textarea:not([id*="inner"])',
    '#nav-rufus-content textarea:not([id*="inner"])',
    '#rufus-view-context textarea:not([id*="inner"])',
    '#nav-rufus-content [contenteditable="true"]',
    '.rufus-textarea-wrapper textarea',
    'textarea[placeholder*="Alexa" i]',
    '[contenteditable="true"][aria-label*="Alexa" i]',
    '[role="textbox"][aria-label*="Alexa" i]',
    '#rufus-chat-input',
    '[data-csa-c-action="rufus-input"]',
    '.rufus-input textarea',
    '.rufus-input input',
    '.rufus-composer textarea',
    '.rufus-composer input',
  ],
  rufusSend: [
    '#rufus-container-main-view button[type="submit"]',
    '#rufus-container-main-view button[aria-label*="Send" i]',
    '#rufus-container-main-view button[aria-label*="发送" i]',
    '#rufus-chat-send',
    '[data-csa-c-action="rufus-send"]',
    '.rufus-send-button',
    'button[aria-label*="Send"]',
    '.rufus-composer button[type="submit"]',
    '.rufus-input-actions button',
  ],
  rufusResponse: [
    '#nav-rufus-content [id^="interaction"]',
    '#rufus-view-context [id^="interaction"]',
    '#rufus-container-main-view [id^="interaction"]',
    '[id^="interaction"]',
    '.rufus-message-bot',
    '.rufus-response',
    '[data-message-type="bot"]',
    '[data-message-role="assistant"]',
    '.rufus-answer',
    '.rufus-message[data-role="assistant"]',
  ],
  rufusLoading: [
    '.rufus-typing-indicator',
    '.rufus-loading',
    '.rufus-spinner',
    '[data-testid="rufus-loading"]',
    '.rufus-message-loading',
  ],
  // 2026-08 实测：侧面板内容容器
  rufusPanel: ['#nav-rufus-content', '#rufus-view-context', '#rufus-panel-header-container'],
  productTitle: ['#productTitle', '#title', 'h1.a-size-large', 'span#productTitle'],
  productPrice: [
    '.a-price .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '.a-price-whole',
    'span.a-price > span.a-offscreen',
  ],
};

const ALEXA_ENTRY_TEXTS = ['ask something else', 'ask alexa'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 注入页面执行的通用工具（findElement / findAllElements / findByText）。
 * 以字符串形式拼进 evaluate，保证与 content.js:213-252 逐行一致。
 */
const PAGE_HELPERS = `
  function findElement(list) {
    for (const sel of list) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (e) {}
    }
    return null;
  }
  function findAllElements(list) {
    for (const sel of list) {
      try { const els = document.querySelectorAll(sel); if (els.length > 0) return Array.from(els); } catch (e) {}
    }
    return [];
  }
  function findByText(selector, textList) {
    const texts = textList.map((t) => t.toLowerCase());
    let nodes;
    try { nodes = document.querySelectorAll(selector); } catch (e) { return null; }
    for (const text of texts) {
      for (const el of nodes) {
        const label = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
        if (label && label.length < 80 && label.includes(text)) return el;
      }
    }
    return null;
  }
`;


/**
 * 判断一段 DOM 文本是不是 Alexa 面板的 UI 样板，而不是真正的答案。
 *
 * 2026-08-26 实测踩到：网络主路超时后，DOM 兜底把面板的欢迎语 + 推荐问题列表 +
 * 反馈表单整段抓走，还被记成 status=success 入库 —— 静默污染数据集，比报错更糟。
 */
function isPanelBoilerplate(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return true;

  const MARKERS = [
    /how can i help\??/i,
    /your feedback has been submitted/i,
    /select all that apply/i,
    /this is (irrelevant|harmful|inaccurate)/i,
    /why you might like this/i,
    /what do customers say\?\s*compare with similar/i,
    /show price history/i,
    /welcome!?\s*i'?m the new alexa/i,
    /my answers are powered by ai/i,
  ];
  const hits = MARKERS.filter((re) => re.test(t)).length;
  if (hits >= 2) return true;                       // 多个样板特征同现 = 样板
  if (/^\{\}/.test(t)) return true;                 // 实测样板常以 "{}" 开头

  // 通篇由问句组成（推荐问题列表），没有陈述句 = 不是答案
  const sentences = t.split(/(?<=[.?!])\s+/).filter((x) => x.trim().length > 8);
  if (sentences.length >= 3) {
    const q = sentences.filter((x) => x.trim().endsWith('?')).length;
    if (q / sentences.length > 0.7) return true;
  }
  return false;
}

/** 商品标题与价格。插件是每题采一次，CLI 改为每 ASIN 一次（schema 不变） */
async function collectMetadata(page, selectors = DEFAULT_SELECTORS) {
  return page.evaluate(({ sel, helpers }) => {
    eval(helpers);
    const t = findElement(sel.productTitle);
    const p = findElement(sel.productPrice);

    // 兜底：订阅类等非典型商品页没有标准的 #productTitle（实测 B08JHCVHTY
    // "blink plus plan with monthly auto-renewal" 整个商品详情 DOM 都不渲染），
    // 但 document.title 里始终带商品名，形如 "Amazon.com: <商品名> : <类目>"。
    let title = t ? t.textContent.trim() : '';
    if (!title) {
      const raw = (document.title || '').trim();
      const m = raw.match(/^Amazon\.[a-z.]+\s*:\s*(.+?)(?:\s*:\s*[^:]+)?$/i);
      title = (m ? m[1] : raw).trim();
    }

    return { productTitle: title, price: p ? p.textContent.trim() : '' };
  }, { sel: selectors, helpers: PAGE_HELPERS });
}

/** content.js:269-284 移植 */
async function openAssistantChat(page, selectors = DEFAULT_SELECTORS) {
  const clicked = await page.evaluate(({ sel, entryTexts, helpers }) => {
    eval(helpers);
    if (findElement(sel.rufusInput)) return 'already-open';
    const btn = findByText('button, a, [role="button"]', entryTexts) || findElement(sel.rufusBtn);
    if (!btn) return 'not-found';
    btn.click();
    return 'clicked';
  }, { sel: selectors, entryTexts: ALEXA_ENTRY_TEXTS, helpers: PAGE_HELPERS });

  if (clicked === 'not-found') {
    throw new Error('找不到 Alexa 入口（Ask Alexa / Ask something else）');
  }
  if (clicked === 'already-open') return true;

  // 等输入框出现，8s —— 与插件一致
  const appeared = await waitForPredicate(page, ({ sel, helpers }) => {
    eval(helpers);
    return !!findElement(sel.rufusInput);
  }, { sel: selectors, helpers: PAGE_HELPERS }, 8000);

  if (!appeared) {
    // 输入框没出现时先读面板文案 —— 只报"输入框未出现"没法行动
    const panel = await readPanelState(page, selectors);
    if (panel.authRequired) {
      const err = new Error(
        'Alexa 要求完整认证：面板提示「Please sign in to begin using Alexa」。'
        + '重放的 cookie 只能到"已识别"状态（账号栏能显示姓名），Alexa 需要在本机真实登录一次'
        + '（其登录链接带 openid.pape.max_auth_age=0，强制实时认证）。'
        + '请执行：apinsight login --account <id>'
      );
      err.incidentType = 'alexa_auth_required';
      throw err;
    }
    throw new Error('点开 Alexa 入口后输入框未出现（8s 超时）'
      + (panel.text ? `；面板文案：「${panel.text.slice(0, 120)}」` : ''));
  }
  await sleep(1000);
  return true;
}

/**
 * 读取 Alexa 侧面板当前状态。
 * 2026-08 实测：cookie 异地重放后面板会显示 "Please sign in to begin using Alexa."，
 * 此时账号栏仍是 "Hello, X" —— 即"已识别但未完整认证"，必须区分出来才能给出可行动的提示。
 */
async function readPanelState(page, selectors = DEFAULT_SELECTORS) {
  return page.evaluate(({ sel, helpers }) => {
    eval(helpers);
    const el = findElement(sel.rufusPanel);
    const text = el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '';
    const signinLink = el
      ? Array.from(el.querySelectorAll('a')).find((a) => /\/ap\/signin/i.test(a.getAttribute('href') || ''))
      : null;
    return {
      present: !!el,
      text,
      authRequired: /please sign in to begin using alexa|sign in to (begin|continue|use) /i.test(text)
        || (!!signinLink && /max_auth_age=0/i.test(signinLink.getAttribute('href') || '')),
      signinHref: signinLink ? signinLink.getAttribute('href') : null,
    };
  }, { sel: selectors, helpers: PAGE_HELPERS }).catch(() => ({ present: false, text: '', authRequired: false }));
}

/** content.js:286-343 移植：保留 React native setter 方案 */
async function askQuestion(page, question, selectors = DEFAULT_SELECTORS) {
  const result = await page.evaluate(async ({ sel, q, helpers }) => {
    eval(helpers);
    const input = findElement(sel.rufusInput);
    if (!input) return 'no-input';

    input.focus();
    input.value = '';

    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    if (nativeSet) nativeSet.call(input, q);
    else input.value = q;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));

    const sendBtn = findElement(sel.rufusSend);
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      return 'sent-click';
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return 'sent-enter';
  }, { sel: selectors, q: question, helpers: PAGE_HELPERS });

  if (result === 'no-input') throw new Error('找不到 Alexa 输入框');
  return result;
}

/** 轮询谓词，替代插件的 waitFor */
async function waitForPredicate(page, fn, arg, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(fn, arg)) return true;
    } catch (e) { /* 导航中等瞬态 */ }
    await sleep(intervalMs);
  }
  return false;
}

/** 当前已有多少个回答容器（提问前先记下，用于 DOM 兜底判定"出现了新回答"） */
async function countResponses(page, selectors = DEFAULT_SELECTORS) {
  return page.evaluate(({ sel, helpers }) => {
    eval(helpers);
    return findAllElements(sel.rufusResponse).length;
  }, { sel: selectors, helpers: PAGE_HELPERS });
}

/** 取页面当前的流游标 */
async function streamCursor(page) {
  return page.evaluate(() => (window.__apinsightCursor ? window.__apinsightCursor() : 0)).catch(() => 0);
}

/**
 * 主路：网络流答案。content.js:412-460 同构，差别只是流数据要从页面拉过来在 Node 侧解析。
 */
async function waitForNetworkAnswer(page, cursor, question, detectionConfig = {}) {
  const { stableChecks = 3, checkInterval = 1.5, maxWaitTime = 60 } = detectionConfig;
  const startTime = Date.now();
  const maxWaitMs = maxWaitTime * 1000;
  const checkIntervalMs = checkInterval * 1000;

  let best = '';
  let lastBest = '';
  let stableCount = 0;

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(checkIntervalMs);

    let pulled;
    try {
      pulled = await page.evaluate((c) => window.__apinsightPullStreams(c), cursor);
    } catch (e) {
      continue;   // 页面导航中，下一轮再试
    }
    if (!pulled) continue;

    let completeAnswer = '';
    for (const stream of pulled.streams) {
      if (!stream.raw) continue;
      if (!sse.isAssistantStreamingUrl(stream.url)) continue;
      const candidate = sse.extractAnswerFromAssistantSse(stream.raw, question);
      if (candidate.length > best.length) best = candidate;
      if (stream.complete && candidate.length > completeAnswer.length) completeAnswer = candidate;
    }

    if (best && best === lastBest) {
      stableCount++;
      if (stableCount >= stableChecks) return { answer: best, source: 'network', complete: false };
    } else {
      stableCount = 0;
    }
    lastBest = best;

    if (completeAnswer) return { answer: completeAnswer, source: 'network', complete: true };
  }

  if (best) return { answer: best, source: 'network', complete: false, timedOut: true };
  throw new Error('网络流未捕获到 Alexa 回答');
}

/** 兜底路：DOM 稳定检测。content.js:345-410 同构 */
async function waitForDomAnswer(page, responsesBefore, detectionConfig = {}, selectors = DEFAULT_SELECTORS) {
  const { stableChecks = 3, checkInterval = 1.5, maxWaitTime = 60 } = detectionConfig;
  const startTime = Date.now();
  const maxWaitMs = maxWaitTime * 1000;
  const checkIntervalMs = checkInterval * 1000;

  const started = await waitForPredicate(page, ({ sel, before, helpers }) => {
    eval(helpers);
    return findAllElements(sel.rufusResponse).length > before;
  }, { sel: selectors, before: responsesBefore, helpers: PAGE_HELPERS }, Math.min(maxWaitMs, 15000));

  if (!started) throw new Error('Alexa 未开始回答（超时）');

  let lastText = '';
  let stableCount = 0;

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(checkIntervalMs);
    let probe;
    try {
      probe = await page.evaluate(({ sel, helpers }) => {
        eval(helpers);
        const responses = findAllElements(sel.rufusResponse);
        const latest = responses[responses.length - 1];
        return {
          text: latest ? latest.textContent.trim() : '',
          isLoading: findElement(sel.rufusLoading) !== null,
        };
      }, { sel: selectors, helpers: PAGE_HELPERS });
    } catch (e) {
      continue;
    }

    // 质量闸门：面板样板文字不算答案，继续等真正的回答
    const looksLikeAnswer = probe.text.length > 0 && !isPanelBoilerplate(probe.text);

    if (looksLikeAnswer && probe.text === lastText && !probe.isLoading) {
      stableCount++;
      if (stableCount >= stableChecks) return { answer: probe.text, source: 'dom', complete: false };
    } else {
      stableCount = 0;
    }
    lastText = probe.text;
  }

  if (lastText.length > 0 && !isPanelBoilerplate(lastText)) {
    return { answer: lastText, source: 'dom', complete: false, timedOut: true };
  }
  // 宁可报错也不要把面板样板当答案入库
  throw new Error(lastText.length
    ? `等待 ${maxWaitTime} 秒，DOM 里只有面板样板文字而非回答`
    : `等待 ${maxWaitTime} 秒后仍未获取到回答`);
}

/**
 * 问一题并拿回答：主路网络流 → 失败退 DOM 兜底。
 * 外层还有 background.js:643 那道 maxWaitTime+15 的硬超时（在 collect 编排里）。
 */
async function askAndCapture(page, question, detectionConfig = {}, selectors = DEFAULT_SELECTORS) {
  const cursor = await streamCursor(page);
  const before = await countResponses(page, selectors);
  const t0 = Date.now();

  await askQuestion(page, question, selectors);

  try {
    const r = await waitForNetworkAnswer(page, cursor, question, detectionConfig);
    if (r.answer) return { ...r, elapsedMs: Date.now() - t0 };
    throw new Error('网络流答案为空');
  } catch (netErr) {
    const r = await waitForDomAnswer(page, before, detectionConfig, selectors);
    return { ...r, elapsedMs: Date.now() - t0, networkError: netErr.message };
  }
}

module.exports = {
  DEFAULT_SELECTORS,
  ALEXA_ENTRY_TEXTS,
  PAGE_HELPERS,
  collectMetadata,
  openAssistantChat,
  readPanelState,
  askQuestion,
  countResponses,
  streamCursor,
  waitForNetworkAnswer,
  waitForDomAnswer,
  isPanelBoilerplate,
  waitForPredicate,
  askAndCapture,
  sleep,
};
