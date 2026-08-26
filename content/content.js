/**
 * Content Script - Alexa 产品洞察 · WaytoAIC
 * Injected into Amazon product pages to interact with the Rufus AI chat interface.
 *
 * Smart Response Detection:
 * - Uses MutationObserver + polling to detect when Rufus finishes streaming
 * - Monitors response text content for stability (N consecutive unchanged checks)
 * - Also watches for loading indicators disappearing
 * - maxWaitTime as a safety net timeout
 */

(function () {
  'use strict';

  if (window.__apinsightInjected) return;
  window.__apinsightInjected = true;

  // ===== DEFAULT SELECTORS =====
  // 注：2026-05 亚马逊把 Rufus 换皮改名 "Alexa for Shopping"，但后端引擎/接口/DOM
  //     内部仍是 Rufus —— 实测：接口仍是 /rufus/cl/streaming，输入框 #rufus-text-area，
  //     容器 #rufus-container-main-view，每轮问答是 #interactionN，连相关问题都带
  //     rufus-color-alexa-blue-900 类。下方为 2026-06 实测选择器（标 ✓），其余为兜底。
  //     入口主要靠文字定位（findByText: "Ask something else"）。
  const DEFAULT_SELECTORS = {
    rufusBtn: [
      // --- 2026-08-26 实测：Alexa 已从商品页内嵌组件改为**全局导航侧边面板** ✓ ---
      //     入口是导航栏的 #nav-rufus-disco（aria-label "Open Alexa panel"）。
      //     下方 2026-06 的内嵌组件选择器在当前页面已全部失效，保留作兜底。
      '#nav-rufus-disco',
      '[aria-label*="Open Alexa panel" i]',
      '#nav-flyout-rufus',
      // --- 2026-06 的商品页内嵌组件（已失效，兜底）---
      '#dpx-nice-widget-container button.ask-pill',
      'button.small-widget-pill.ask-pill',
      '.ask-pill',
      '[aria-label*="Ask Alexa" i]',
      '[data-csa-c-content-id*="alexa" i]',
      // --- legacy Rufus ---
      '#rufus-entry-point',
      '[data-csa-c-action="rufus-open"]',
      '.rufus-chat-button',
      'button[aria-label*="Rufus"]',
      '[data-action="rufus"]',
      '#ask-rufus-button',
      '.a-button-rufus',
    ],
    rufusInput: [
      // --- Alexa for Shopping：实测输入框（稳定 ID）✓ ---
      //     ⚠️ 2026-08-26 实测：面板里另有一个**隐藏的反馈输入框**
      //     #rufus-text-area-inner-N（placeholder "Add your feedback..."），
      //     且在 DOM 里排更前 —— 泛化的 `... textarea` 选择器会先命中它，
      //     把问题打进反馈框。故稳定 ID 必须最前，泛化候选一律带 :not() 排除。
      '#rufus-text-area',
      '#rufus-container-main-view textarea:not([id*="inner"])',
      '#nav-rufus-content textarea:not([id*="inner"])',
      '.rufus-textarea-wrapper textarea',
      // --- 收窄到含 Alexa 的兜底（避开搜索框） ---
      'textarea[placeholder*="Alexa" i]',
      '[contenteditable="true"][aria-label*="Alexa" i]',
      '[role="textbox"][aria-label*="Alexa" i]',
      // --- legacy Rufus ---
      '#rufus-chat-input',
      '[data-csa-c-action="rufus-input"]',
      '.rufus-input textarea',
      '.rufus-input input',
      '.rufus-composer textarea',
      '.rufus-composer input',
    ],
    rufusSend: [
      // --- Alexa for Shopping：发送键在 Rufus 主容器内（未直接抓到，按结构推断，否则 Enter 兜底） ---
      '#rufus-container-main-view button[type="submit"]',
      '#rufus-container-main-view button[aria-label*="Send" i]',
      '#rufus-container-main-view button[aria-label*="发送" i]',
      // --- legacy Rufus ---
      '#rufus-chat-send',
      '[data-csa-c-action="rufus-send"]',
      '.rufus-send-button',
      'button[aria-label*="Send"]',
      '.rufus-composer button[type="submit"]',
      '.rufus-input-actions button',
    ],
    rufusResponse: [
      // --- Alexa for Shopping：每轮问答是一个 #interactionN 容器（实测）✓ ---
      //     2026-08-26 复核：认证后的侧面板里 #rufus-container-main-view 仍在，
      //     内部结构未变；补上面板作用域作为更精确的前置候选。
      '#nav-rufus-content [id^="interaction"]',
      '#rufus-container-main-view [id^="interaction"]',
      '[id^="interaction"]',
      // --- legacy Rufus ---
      '.rufus-message-bot',
      '.rufus-response',
      '[data-message-type="bot"]',
      '[data-message-role="assistant"]',
      '.rufus-answer',
      '.rufus-message[data-role="assistant"]',
    ],
    // Loading/typing indicators
    rufusLoading: [
      '.rufus-typing-indicator',
      '.rufus-loading',
      '.rufus-spinner',
      '[data-testid="rufus-loading"]',
      '.rufus-message-loading',
    ],
    productTitle: ['#productTitle', '#title', 'h1.a-size-large', 'span#productTitle'],
    productPrice: [
      '.a-price .a-offscreen',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '.a-price-whole',
      'span.a-price > span.a-offscreen',
    ],
  };
  let activeSelectors = DEFAULT_SELECTORS;
  const NETWORK_SOURCE = 'apinsight-net';
  // ⚠️ 2026-08-26 实测：单题原始 SSE 流实测 152KB–446KB，旧的 300000 上限会被击穿。
  // 而 Alexa 答案是 JSON Patch 流，创建根节点的 `op:add path:"/"` 就在流的最开头，
  // 超限时保留尾部丢弃头部 = 根节点丢失 = 后续 patch 全被跳过 = 答案静默变空。
  // 放大到 2MB 并显式标记截断。与 cli/src/lib/inject/collector-hook.js 同步。
  const MAX_NETWORK_RAW_CHARS = 2000000;
  const networkStreams = new Map();
  let networkSeq = 0;
  window.__apinsightNetDebug = [];

  function normalizeSelectorList(selectorList) {
    if (!selectorList) return [];
    if (Array.isArray(selectorList)) return selectorList.filter(Boolean);
    return String(selectorList).split(',').map((s) => s.trim()).filter(Boolean);
  }

  function mergeSelectorList(customSelectors, defaultSelectors) {
    const customList = normalizeSelectorList(customSelectors);
    return customList.length ? [...customList, ...defaultSelectors] : defaultSelectors;
  }

  function buildSelectors(settings) {
    const custom = settings?.selectors || {};
    return {
      ...DEFAULT_SELECTORS,
      rufusBtn: mergeSelectorList(custom.rufusBtn, DEFAULT_SELECTORS.rufusBtn),
      rufusInput: mergeSelectorList(custom.rufusInput, DEFAULT_SELECTORS.rufusInput),
      rufusSend: mergeSelectorList(custom.rufusSend, DEFAULT_SELECTORS.rufusSend),
      rufusResponse: mergeSelectorList(custom.rufusResponse, DEFAULT_SELECTORS.rufusResponse),
    };
  }

  // ===== NETWORK STREAM CAPTURE =====
  window.addEventListener('message', (event) => {
    if (event.data?.source !== NETWORK_SOURCE) return;

    const { type, payload = {} } = event.data;
    if (!payload.id && type !== 'ready') return;

    if (type === 'ready') {
      log('Network hook ready');
      return;
    }

    let stream = networkStreams.get(payload.id);
    if (!stream) {
      stream = {
        seq: ++networkSeq,
        id: payload.id,
        url: payload.url || '',
        frameUrl: payload.frameUrl || '',
        method: payload.method || '',
        body: payload.body || '',
        raw: '',
        complete: false,
        updatedAt: Date.now(),
      };
      networkStreams.set(payload.id, stream);
    }

    if (payload.url) stream.url = payload.url;
    if (payload.frameUrl) stream.frameUrl = payload.frameUrl;
    if (payload.method) stream.method = payload.method;
    if (payload.body) stream.body = payload.body;
    if (payload.text) {
      stream.raw += payload.text;
      if (stream.raw.length > MAX_NETWORK_RAW_CHARS) {
        stream.raw = stream.raw.slice(-MAX_NETWORK_RAW_CHARS);
        stream.truncated = true;   // 截断即不可用：JSON Patch 丢头无法重建
      }
    }
    if (type === 'complete') stream.complete = true;
    stream.updatedAt = Date.now();
    updateNetworkDebugStore(stream);

    logNetworkDebug(type, stream);
  });

  function updateNetworkDebugStore(stream) {
    const debug = {
      id: stream.id,
      seq: stream.seq,
      complete: stream.complete,
      url: stream.url,
      frameUrl: stream.frameUrl,
      method: stream.method,
      rawChars: stream.raw.length,
      sample: stream.raw.slice(-1000),
    };
    const existingIndex = window.__apinsightNetDebug.findIndex((item) => item.id === stream.id);
    if (existingIndex >= 0) {
      window.__apinsightNetDebug[existingIndex] = debug;
    } else {
      window.__apinsightNetDebug.push(debug);
      if (window.__apinsightNetDebug.length > 30) window.__apinsightNetDebug.shift();
    }
  }

  function logNetworkDebug(type, stream) {
    const sample = stream.raw.slice(-240).replace(/\s+/g, ' ').trim();
    console.log('[Alexa洞察][network]', JSON.stringify({
      type,
      id: stream.id,
      seq: stream.seq,
      complete: stream.complete,
      url: stream.url,
      frameUrl: stream.frameUrl,
      rawChars: stream.raw.length,
      sample,
    }));
  }

  function getNetworkCursor() {
    return networkSeq;
  }

  // ===== ELEMENT FINDER =====
  function findElement(selectorList) {
    selectorList = normalizeSelectorList(selectorList);
    for (const sel of selectorList) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) { /* skip invalid selector */ }
    }
    return null;
  }

  function findAllElements(selectorList) {
    selectorList = normalizeSelectorList(selectorList);
    for (const sel of selectorList) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return Array.from(els);
      } catch (e) { /* skip */ }
    }
    return [];
  }

  /**
   * 文字定位：按可见文本找元素，比写死的 class/id 更耐亚马逊改版。
   * 用于 Alexa "Ask something else" / "Ask Alexa" 这类有稳定文案的入口。
   * @param {string} selector  候选元素的 CSS（如 'button, a, [role="button"]'）
   * @param {string[]} textList 要匹配的文本（小写包含匹配，越靠前优先级越高）
   */
  function findByText(selector, textList) {
    const texts = (Array.isArray(textList) ? textList : [textList]).map((t) => t.toLowerCase());
    let nodes;
    try { nodes = document.querySelectorAll(selector); } catch (e) { return null; }
    for (const text of texts) {
      for (const el of nodes) {
        const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.trim().toLowerCase();
        if (label && label.length < 80 && label.includes(text)) return el;
      }
    }
    return null;
  }

  // Alexa for Shopping 内嵌组件的入口文案（自由提问走 "ask something else"）
  const ALEXA_ENTRY_TEXTS = ['ask something else', 'ask alexa'];

  // ===== PRODUCT METADATA =====
  function getProductTitle() {
    const el = findElement(activeSelectors.productTitle);
    if (el) return el.textContent.trim();
    // 兜底：订阅类等非典型商品页不渲染标准商品详情 DOM（实测 B08JHCVHTY
    // "blink plus plan with monthly auto-renewal" 连 #dp-container 都没有），
    // 但 document.title 始终带商品名，形如 "Amazon.com: <商品名> : <类目>"。
    const raw = (document.title || '').trim();
    const m = raw.match(/^Amazon\.[a-z.]+\s*:\s*(.+?)(?:\s*:\s*[^:]+)?$/i);
    return (m ? m[1] : raw).trim();
  }

  function getProductPrice() {
    const el = findElement(activeSelectors.productPrice);
    return el ? el.textContent.trim() : '';
  }

  // ===== RUFUS / ALEXA INTERACTION =====
  async function openAssistantChat() {
    // 组件可能已经展开（输入框已在），直接复用，省一次点击。
    if (findElement(activeSelectors.rufusInput)) return true;

    // 入口优先级：文字定位（"Ask something else" 最稳）→ 显式选择器兜底。
    let btn = findByText('button, a, [role="button"]', ALEXA_ENTRY_TEXTS)
      || findElement(activeSelectors.rufusBtn);

    if (!btn) {
      throw new Error('找不到 Alexa 入口（Ask Alexa / Ask something else），请在设置中更新选择器');
    }
    btn.click();
    await waitFor(() => findElement(activeSelectors.rufusInput), 8000);
    await sleep(1000);
    return true;
  }

  async function askQuestion(question) {
    let input = findElement(activeSelectors.rufusInput);
    if (!input) {
      await openAssistantChat();
      input = findElement(activeSelectors.rufusInput);
    }
    if (!input) {
      throw new Error('找不到 Alexa 输入框，请在设置中更新选择器');
    }

    // Clear and type
    input.focus();
    input.value = '';

    // Use native setter for React compatibility
    const nativeSet = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;

    if (nativeSet) {
      nativeSet.call(input, question);
    } else {
      input.value = question;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);

    // Click send or press Enter
    const sendBtn = findElement(activeSelectors.rufusSend);
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
      }));
      input.dispatchEvent(new KeyboardEvent('keypress', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
      }));
    }
  }

  /**
   * Smart Response Detection
   * 
   * Strategy:
   * 1. Record how many response elements exist BEFORE asking
   * 2. Wait for a NEW response element to appear (MutationObserver + polling)
   * 3. Once found, repeatedly sample the response text at `checkInterval`
   * 4. If the text content is unchanged for `stableChecks` consecutive samples → DONE
   * 5. Also check if loading indicators have disappeared
   * 6. `maxWaitTime` is a safety timeout to prevent infinite waiting
   *
   * @param {object} detectionConfig - { stableChecks, checkInterval, maxWaitTime }
   * @returns {string} The final response text
   */
  async function waitForResponseSmart(detectionConfig, responsesBefore) {
    const {
      stableChecks = 3,
      checkInterval = 1.5,
      maxWaitTime = 60,
    } = detectionConfig;

    const startTime = Date.now();
    const maxWaitMs = maxWaitTime * 1000;
    const checkIntervalMs = checkInterval * 1000;
    // Phase 1: Wait for a NEW response element to appear
    log('⏳ 等待 Alexa 开始回答...');
    try {
      await waitFor(() => {
        return findAllElements(activeSelectors.rufusResponse).length > responsesBefore;
      }, Math.min(maxWaitMs, 15000));
    } catch (e) {
      throw new Error('Alexa 未开始回答（超时）');
    }

    // Phase 2: Smart stability detection
    log('📝 检测回答是否完成...');
    let lastText = '';
    let stableCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      await sleep(checkIntervalMs);

      // Get latest response text
      const responses = findAllElements(activeSelectors.rufusResponse);
      const latestResponse = responses[responses.length - 1];
      const currentText = latestResponse ? latestResponse.textContent.trim() : '';

      // Check if loading indicator is still visible
      const isLoading = findElement(activeSelectors.rufusLoading) !== null;

      if (currentText.length > 0 && currentText === lastText && !isLoading) {
        stableCount++;
        log(`✓ 稳定检测 ${stableCount}/${stableChecks}`);
        if (stableCount >= stableChecks) {
          log('✅ 回答已完成（内容稳定）');
          return currentText;
        }
      } else {
        // Text still changing or loading indicator still visible
        if (stableCount > 0) {
          log('↻ 内容仍在变化，重置计数');
        }
        stableCount = 0;
      }

      lastText = currentText;
    }

    // Safety timeout reached - return whatever we have
    const responses = findAllElements(activeSelectors.rufusResponse);
    const latestResponse = responses[responses.length - 1];
    const finalText = latestResponse ? latestResponse.textContent.trim() : '';

    if (finalText.length > 0) {
      log('⚠️ 达到超时上限，返回当前内容');
      return finalText;
    }

    throw new Error(`等待 ${maxWaitTime} 秒后仍未获取到回答`);
  }

  async function waitForNetworkResponse(detectionConfig, cursor, question) {
    const {
      stableChecks = 3,
      checkInterval = 1.5,
      maxWaitTime = 60,
    } = detectionConfig;

    const startTime = Date.now();
    const maxWaitMs = maxWaitTime * 1000;
    const checkIntervalMs = checkInterval * 1000;
    let best = '';
    let lastBest = '';
    let stableCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      await sleep(checkIntervalMs);

      for (const stream of networkStreams.values()) {
        if (stream.seq <= cursor || !stream.raw) continue;
        if (!isAssistantStreamingUrl(stream.url)) continue;
        const candidate = extractAnswerFromNetworkStream(stream, question);
        if (candidate.length > best.length) best = candidate;
      }

      if (best && best === lastBest) {
        stableCount++;
        if (stableCount >= stableChecks) {
          log('✅ 网络流回答已稳定');
          return best;
        }
      } else {
        stableCount = 0;
      }

      lastBest = best;

      const completeAnswer = getCompleteNetworkAnswer(cursor, question);
      if (completeAnswer) {
        log('✅ 网络流回答已完成');
        return completeAnswer;
      }
    }

    if (best) {
      log('⚠️ 网络流达到超时上限，返回当前内容');
      return best;
    }

    throw new Error('网络流未捕获到 Alexa 回答');
  }

  function getCompleteNetworkAnswer(cursor, question) {
    let best = '';
    for (const stream of networkStreams.values()) {
      if (stream.seq <= cursor || !stream.complete || !stream.raw) continue;
      if (!isAssistantStreamingUrl(stream.url)) continue;
      const candidate = extractAnswerFromNetworkStream(stream, question);
      if (candidate.length > best.length) best = candidate;
    }
    return best;
  }

  function extractAnswerFromNetworkStream(stream, question) {
    if (isAssistantStreamingUrl(stream.url)) {
      return extractAnswerFromAssistantSse(stream.raw, question);
    }

    return extractAnswerFromNetworkText(stream.raw, question);
  }

  function isAssistantStreamingUrl(url) {
    // 兼容 Alexa for Shopping（原 Rufus）：两者历史上都走 /cl/streaming 风格的 SSE 端点。
    // 待真实抓包确认 Alexa 端点后可进一步收窄。
    return /\/(rufus|alexa)\/cl\/streaming/i.test(url || '')
      || /\/cl\/streaming/i.test(url || '');
  }

  // ===== JSON Patch 主路（2026-08-26 实测的真实格式）=====
  //
  // Alexa 的答案不是"逐段追加文本"，而是 RFC 6902 JSON Patch 流：
  //   {type:"JSONPatches", patches:[{op:"add"|"replace", path:"/children/0/children/1",
  //                                  groupId:"markdown_processor_XXX_0", value:{...}}]}
  // 同一路径会被 replace 上百次（实测单流 193 次 replace / 14 次 add）。
  //
  // 下方的 collectAssistantPatchText + buildAnswerFromTextPatches 把见过的每个
  // value.children 全收集起来，只靠"后面有更长版本包含它"去重 —— 对 JSON Patch 语义
  // 是错的：中间态全被保留，产出形如「Based on customer reviews for the [**Blink
  // Subscription Plus / Based on customer reviews for the / , the most common
  // complaints are:」的重复碎片。正确做法是按序应用 patch 重建文档树再取文本。
  //
  // ⚠️ 本段与 cli/src/lib/sse-parser.js 逐字一致，CLI 侧有差分测试锁住，改动需双向同步。

  /** 解析 JSON Pointer 成 token 数组；'/' 表示根 */
  function parsePointer(path) {
    if (path === undefined || path === null) return null;
    const p = String(path);
    if (p === '' || p === '/') return [];
    if (p[0] !== '/') return null;
    return p.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  }

  /** 按 token 路径取容器与末端键 */
  function locate(root, tokens) {
    let cur = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i];
      if (cur == null) return null;
      const key = Array.isArray(cur) ? Number(t) : t;
      cur = cur[key];
    }
    return { parent: cur, key: tokens.length ? tokens[tokens.length - 1] : null };
  }

  /**
   * 把一条 SSE 流里的 JSONPatches 按序应用，按 groupId 分别重建文档树。
   * 这是 Alexa 当前真实的答案传输格式（2026-08-26 实测）：
   * op=add/replace + JSON Pointer + 节点值，同一路径会被 replace 上百次。
   */
  function applyJsonPatchStream(payloads) {
    const trees = new Map();     // groupId -> root
    for (const msg of payloads) {
      if (!msg || msg.type !== 'JSONPatches' || !Array.isArray(msg.patches)) continue;
      for (const p of msg.patches) {
        const gid = String(p.groupId || '');
        const tokens = parsePointer(p.path);
        if (tokens === null) continue;

        if (tokens.length === 0) {
          // 根节点：add / replace 都是整体设置
          trees.set(gid, p.value);
          continue;
        }
        const root = trees.get(gid);
        if (root === undefined) continue;          // 没有根就无从下手

        const loc = locate(root, tokens);
        if (!loc || loc.parent == null) continue;
        const { parent, key } = loc;

        if (Array.isArray(parent)) {
          const idx = key === '-' ? parent.length : Number(key);
          if (!Number.isFinite(idx)) continue;
          if (p.op === 'add') parent.splice(idx, 0, p.value);
          else if (p.op === 'replace') parent[idx] = p.value;
          else if (p.op === 'remove') parent.splice(idx, 1);
        } else if (typeof parent === 'object') {
          if (p.op === 'remove') delete parent[key];
          else parent[key] = p.value;              // add / replace 同义
        }
      }
    }
    return trees;
  }

  /** 遍历重建后的节点树，按文档顺序取出文本 */
  function textFromNode(node, out) {
    if (node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach((n) => textFromNode(n, out)); return; }
    if (typeof node !== 'object') return;

    const t = String(node.type || '');
    // 结构性换行：段落/列表项之间要断行，否则会糊成一坨
    const isBlock = /paragraph|list|listitem|heading|container|section/i.test(t);
    if (isBlock && out.length && out[out.length - 1] !== '\n') out.push('\n');

    if (typeof node.children === 'string') out.push(node.children);
    else if (node.children !== undefined) textFromNode(node.children, out);

    if (isBlock && out.length && out[out.length - 1] !== '\n') out.push('\n');
  }

  /** 主路：按 JSON Patch 语义重建答案 */
  function extractAnswerFromJsonPatches(raw, question) {
    const payloads = extractSseDataPayloads(raw)
      .map(tryParseJson)
      .filter((o) => o && o.type === 'JSONPatches');
    if (!payloads.length) return '';

    const trees = applyJsonPatchStream(payloads);
    const pieces = [];
    for (const [gid, root] of trees) {
      // 只取答案正文分组，与插件的 markdown_processor 过滤口径一致
      if (!/markdown_processor/i.test(gid)) continue;
      const out = [];
      textFromNode(root, out);
      const text = out.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (text) pieces.push(text);
    }
    if (!pieces.length) return '';

    const answer = stripHtmlEntities(pieces.join('\n\n')).trim();
    if (question && normalizeComparable(answer) === normalizeComparable(question)) return '';
    return answer;
  }

  function extractAnswerFromAssistantSse(raw, question) {
    // 主路：JSON Patch 语义重建（当前真实格式）
    const viaPatches = extractAnswerFromJsonPatches(raw, question);
    if (viaPatches) return viaPatches;

    // 兜底：历史启发式（旧格式流仍走它）
    return extractAnswerFromAssistantSseLegacy(raw, question);
  }

  function extractAnswerFromAssistantSseLegacy(raw, question) {
    const texts = [];
    const payloads = extractSseDataPayloads(raw);

    for (const payload of payloads) {
      const parsed = tryParseJson(payload);
      if (parsed === undefined) continue;
      collectAssistantPatchText(parsed, texts);
    }

    return buildAnswerFromTextPatches(texts, question);
  }

  function extractSseDataPayloads(raw) {
    const payloads = [];
    const dataPattern = /(?:^|[\r\n\s])data:(\{.*?\})(?=(?:[\r\n\s]+id:)|(?:[\r\n\s]+event:)|$)/gs;
    let match;

    while ((match = dataPattern.exec(raw)) !== null) {
      payloads.push(match[1].trim());
    }

    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:{')) return;
      const payload = trimmed.slice(5).trim();
      if (payload && !payloads.includes(payload)) payloads.push(payload);
    });

    return payloads;
  }

  function collectAssistantPatchText(value, output, inAnswerPatch = false) {
    if (value == null) return;

    if (Array.isArray(value)) {
      value.forEach((item) => collectAssistantPatchText(item, output, inAnswerPatch));
      return;
    }

    if (typeof value !== 'object') return;

    const patchValue = value.value;
    const groupId = String(value.groupId || '');
    const path = String(value.path || '');
    const isAnswerPatch = inAnswerPatch || /markdown_processor/i.test(groupId) || /markdown_processor/i.test(path);

    if (isAnswerPatch && patchValue && patchValue.type === 'text' && typeof patchValue.children === 'string') {
      output.push(patchValue.children);
    }

    if (isAnswerPatch && value.type === 'text' && typeof value.children === 'string') {
      output.push(value.children);
    }

    Object.entries(value).forEach(([key, childValue]) => {
      if (key === 'children' && typeof childValue === 'string') return;
      collectAssistantPatchText(childValue, output, isAnswerPatch);
    });
  }

  function buildAnswerFromTextPatches(texts, question) {
    const cleaned = texts
      .map(cleanCandidateText)
      .map(stripHtmlEntities)
      .filter(Boolean)
      .filter((text) => isUsefulAnswerText(text, question))
      .filter((text) => !isRelatedQuestionText(text))
      .filter((text) => !/^thinking\.?$/i.test(text))
      .filter((text) => !/^source:?$/i.test(text));

    if (cleaned.length === 0) return '';

    const finalPieces = [];

    cleaned.forEach((text, index) => {
      const normalized = normalizeComparable(text);
      const hasLongerLaterVersion = cleaned.slice(index + 1).some((later) => {
        const laterNormalized = normalizeComparable(later);
        return laterNormalized.length > normalized.length && laterNormalized.includes(normalized);
      });

      if (!hasLongerLaterVersion) finalPieces.push(text);
    });

    const seen = new Set();
    const deduped = finalPieces.filter((text) => {
      const key = normalizeComparable(text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractAnswerFromNetworkText(raw, question) {
    const strings = [];
    const seen = new Set();
    const segments = splitStreamSegments(raw);

    for (const segment of segments) {
      const parsed = tryParseJson(segment);
      if (parsed !== undefined) {
        collectTextCandidates(parsed, strings);
      } else {
        collectRegexTextCandidates(segment, strings);
      }
    }

    const cleaned = strings
      .map(cleanCandidateText)
      .filter(Boolean)
      .filter((text) => isUsefulAnswerText(text, question))
      .filter((text) => {
        const key = text.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (cleaned.length === 0) return '';

    const joined = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return joined.length > 80 ? joined : cleaned.sort((a, b) => b.length - a.length)[0] || '';
  }

  function splitStreamSegments(raw) {
    const segments = [];
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]') return;
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data && data !== '[DONE]') segments.push(data);
      } else {
        segments.push(trimmed);
      }
    });
    if (segments.length === 0 && raw.trim()) segments.push(raw.trim());
    return segments;
  }

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return undefined;
    }
  }

  function collectRegexTextCandidates(text, output) {
    const keyPattern = /"(?:text|content|answer|message|completion|delta|outputText|utterance|value|children)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let match;
    while ((match = keyPattern.exec(text)) !== null) {
      try {
        output.push(JSON.parse(`"${match[1]}"`));
      } catch (e) {
        output.push(match[1]);
      }
    }
  }

  function collectTextCandidates(value, output, key = '') {
    if (value == null) return;

    if (typeof value === 'string') {
      if (isPreferredTextKey(key)) output.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => collectTextCandidates(item, output, key));
      return;
    }

    if (typeof value !== 'object') return;

    Object.entries(value).forEach(([childKey, childValue]) => {
      if (typeof childValue === 'string' && isPreferredTextKey(childKey)) {
        output.push(childValue);
      } else {
        collectTextCandidates(childValue, output, childKey);
      }
    });
  }

  function isPreferredTextKey(key) {
    return /^(text|content|answer|message|completion|delta|outputText|utterance|value|children|plainText|markdown)$/i.test(key);
  }

  function cleanCandidateText(text) {
    return String(text || '')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\s+\n/g, '\n')
      .replace(/\n\s+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function isUsefulAnswerText(text, question) {
    if (!text || text.length < 12) return false;
    if (/^(GET|POST|PUT|DELETE)\s+/i.test(text)) return false;
    if (/^(https?:)?\/\//i.test(text)) return false;
    if (question && normalizeComparable(text) === normalizeComparable(question)) return false;
    return /[a-z0-9]/i.test(text);
  }

  function isRelatedQuestionText(text) {
    const normalized = normalizeComparable(text);
    if (normalized.endsWith('?') && normalized.length < 90) return true;
    return /^(how do i|what's the|compare|is it|can it|does it|best places to|how long does)/i.test(normalized);
  }

  function stripHtmlEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
  }

  function normalizeComparable(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // ===== MESSAGE HANDLER =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'ASK_RUFUS') {
      handleAskAssistant(msg.payload);
      sendResponse({ ok: true });
    } else if (msg.action === 'PING') {
      sendResponse({ ok: true, ready: true });
    }
    return true;
  });

  async function handleAskAssistant(payload) {
    const { question, category, asin, questionIndex, settings } = payload;
    activeSelectors = buildSelectors(settings);

    const detectionConfig = {
      stableChecks: settings?.stableChecks || 3,
      checkInterval: settings?.checkInterval || 1.5,
      maxWaitTime: settings?.maxWaitTime || 60,
    };

    try {
      const productTitle = settings?.collectMetadata ? getProductTitle() : '';
      const price = settings?.collectMetadata ? getProductPrice() : '';

      const responsesBefore = findAllElements(activeSelectors.rufusResponse).length;
      const networkCursor = getNetworkCursor();

      // Ask question
      await askQuestion(question);

      let answer = '';
      try {
        answer = await waitForNetworkResponse(detectionConfig, networkCursor, question);
      } catch (networkErr) {
        log(`网络流读取失败，改用页面文本兜底: ${networkErr.message}`);
        answer = await waitForResponseSmart(detectionConfig, responsesBefore);
      }

      chrome.runtime.sendMessage({
        action: 'RUFUS_RESPONSE',
        payload: { asin, productTitle, price, category, question, questionIndex, answer },
      });
    } catch (err) {
      chrome.runtime.sendMessage({
        action: 'RUFUS_ERROR',
        payload: { asin, category, question, questionIndex, error: err.message },
      });
    }
  }

  // ===== UTILITIES =====
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitFor(conditionFn, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (conditionFn()) {
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('等待超时'));
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  function log(msg) {
    console.log(`[Alexa洞察] ${msg}`);
  }

  chrome.runtime.sendMessage({ action: 'CONTENT_READY' }).catch(() => {});
})();
