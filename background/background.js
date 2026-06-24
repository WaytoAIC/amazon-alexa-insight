/**
 * Background Service Worker - Alexa 产品洞察 · WaytoAIC
 * 
 * 核心职责：
 * - 任务编排（导航 ASIN、调度问题）
 * - 作为状态中心：popup 关闭后任务继续运行
 * - popup 重新打开时，返回当前状态供恢复
 * - 结果持久化到 chrome.storage
 */

// ===== COLLECTION STATE (source of truth) =====
let collectionState = {
  isRunning: false,
  isPaused: false,
  phase: 'idle',
  marketplace: 'US',
  asins: [],
  questions: [],
  settings: {},
  currentAsinIndex: 0,
  currentQuestionIndex: 0,
  results: [],
  logs: [],
  activeTabId: null,
  autoExported: false,
};

const MAX_LOGS = 100;
const TASK_STORAGE_KEY = 'apinsightTaskState';

const MARKETPLACE_DOMAINS = {
  US: 'www.amazon.com', UK: 'www.amazon.co.uk', DE: 'www.amazon.de',
  FR: 'www.amazon.fr', IT: 'www.amazon.it', ES: 'www.amazon.es',
  JP: 'www.amazon.co.jp', CA: 'www.amazon.ca', AU: 'www.amazon.com.au',
  IN: 'www.amazon.in', MX: 'www.amazon.com.mx', SG: 'www.amazon.sg',
  BR: 'www.amazon.com.br', NL: 'www.amazon.nl', SA: 'www.amazon.sa',
  AE: 'www.amazon.ae', PL: 'www.amazon.pl', SE: 'www.amazon.se',
  BE: 'www.amazon.com.be', EG: 'www.amazon.eg',
};

// ===== MESSAGE LISTENER =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse);
  return true;
});

async function handleMessage(msg, sender) {
  await stateReady;

  switch (msg.action) {
    case 'START_COLLECTION':
      startCollection(msg.payload);
      return { ok: true };
    case 'PAUSE_COLLECTION':
      collectionState.isPaused = true;
      collectionState.phase = 'paused';
      persistTaskState();
      return { ok: true };
    case 'RESUME_COLLECTION':
      collectionState.isPaused = false;
      collectionState.phase = 'asking';
      persistTaskState();
      processNext();
      return { ok: true };
    case 'STOP_COLLECTION':
      stopCollection();
      return { ok: true };
    case 'GET_STATE':
      // Popup requests current state on open/reconnect
      return {
        ok: true,
        state: {
          isRunning: collectionState.isRunning,
          isPaused: collectionState.isPaused,
          marketplace: collectionState.marketplace,
          asins: collectionState.asins,
          results: collectionState.results,
          logs: collectionState.logs,
          currentAsinIndex: collectionState.currentAsinIndex,
          currentQuestionIndex: collectionState.currentQuestionIndex,
          totalQuestions: collectionState.questions.length,
          currentAsin: collectionState.asins[collectionState.currentAsinIndex] || '',
          currentQuestion: collectionState.questions[collectionState.currentQuestionIndex]?.question || '',
        },
      };
    case 'CONTENT_READY':
      if (collectionState.isRunning && collectionState.phase === 'navigating' && sender?.tab?.id === collectionState.activeTabId) {
        scheduleStartQuestions();
      }
      return { ok: true };
    case 'RUFUS_RESPONSE':
      handleAssistantResponse(msg.payload);
      return { ok: true };
    case 'RUFUS_ERROR':
      handleAssistantError(msg.payload);
      return { ok: true };
    case 'CLEAR_TASK':
      collectionState.isRunning = false;
      collectionState.isPaused = false;
      collectionState.phase = 'idle';
      collectionState.results = [];
      collectionState.logs = [];
      collectionState.currentAsinIndex = 0;
      collectionState.currentQuestionIndex = 0;
      await chrome.storage.local.remove(['apinsightResults', TASK_STORAGE_KEY]);
      return { ok: true };
    case 'CLEAR_RESULTS':
      collectionState.results = [];
      collectionState.autoExported = false;
      await chrome.storage.local.remove('apinsightResults');
      persistTaskState();
      return { ok: true };
    case 'TEST_LLM':
      try {
        const sample = 'This product is durable and well made, but customers say the battery life is short.';
        const text = await translateWithLlm(sample, msg.payload?.llm || {});
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    default:
      return { ok: false, error: `Unknown action: ${msg.action}` };
  }
}

// ===== COLLECTION ORCHESTRATION =====
async function startCollection(payload) {
  collectionState = {
    isRunning: true,
    isPaused: false,
    phase: 'starting',
    marketplace: payload.marketplace,
    asins: payload.asins,
    questions: payload.questions,
    settings: payload.settings,
    currentAsinIndex: 0,
    currentQuestionIndex: 0,
    results: [],
    logs: [],
    activeTabId: null,
    autoExported: false,
  };

  addLog('info', `开始采集 ${payload.asins.length} 个 ASIN，共 ${payload.questions.length} 个问题/ASIN`);
  // Persist initial state
  persistTaskState();
  await navigateToAsin(0);
}

function stopCollection() {
  collectionState.isRunning = false;
  collectionState.isPaused = false;
  collectionState.phase = 'idle';
  addLog('warning', '采集已停止');
  persistTaskState();
  broadcastToPopup({ action: 'COLLECTION_COMPLETE' });
}

async function navigateToAsin(index) {
  if (!collectionState.isRunning || index >= collectionState.asins.length) {
    collectionState.isRunning = false;
    collectionState.phase = 'idle';
    addLog('success', '所有 ASIN 采集完成！');
    persistTaskState();
    autoExportCsvIfNeeded();
    broadcastToPopup({ action: 'COLLECTION_COMPLETE' });
    return;
  }

  collectionState.currentAsinIndex = index;
  collectionState.currentQuestionIndex = 0;
  collectionState.phase = 'navigating';
  const asin = collectionState.asins[index];
  const domain = MARKETPLACE_DOMAINS[collectionState.marketplace] || MARKETPLACE_DOMAINS.US;
  const url = `https://${domain}/dp/${asin}`;

  addLog('info', `正在打开 ASIN: ${asin} (${index + 1}/${collectionState.asins.length})`);
  broadcastProgress();
  persistTaskState();

  try {
    if (collectionState.activeTabId) {
      try {
        await chrome.tabs.update(collectionState.activeTabId, { url });
      } catch (e) {
        // Tab may have been closed, create new one
        const tab = await chrome.tabs.create({ url, active: false });
        collectionState.activeTabId = tab.id;
      }
    } else {
      const tab = await chrome.tabs.create({ url, active: false });
      collectionState.activeTabId = tab.id;
    }
    persistTaskState();

    const tab = await chrome.tabs.get(collectionState.activeTabId);
    if (tab.status === 'complete') {
      scheduleStartQuestions();
    }
  } catch (err) {
    addLog('error', `打开 ASIN ${asin} 失败: ${err.message}`);
    setTimeout(() => navigateToAsin(index + 1), 2000);
  }
}

async function startQuestionsForCurrentAsin() {
  if (!collectionState.isRunning || collectionState.isPaused) return;
  collectionState.phase = 'asking';
  collectionState.currentQuestionIndex = 0;
  persistTaskState();
  await askCurrentQuestion();
}

async function askCurrentQuestion() {
  if (!collectionState.isRunning) return;
  if (collectionState.isPaused) return;

  const qIndex = collectionState.currentQuestionIndex;
  const questions = collectionState.questions;

  if (qIndex >= questions.length) {
    addLog('success', `ASIN ${collectionState.asins[collectionState.currentAsinIndex]} 所有问题已完成`);
    persistTaskState();
    setTimeout(() => navigateToAsin(collectionState.currentAsinIndex + 1), 2000);
    return;
  }

  const q = questions[qIndex];
  collectionState.phase = 'asking';
  addLog('info', `提问 ${qIndex + 1}/${questions.length}: ${q.question.slice(0, 50)}...`);
  broadcastProgress();
  persistTaskState();

  // Safety timeout: if content script doesn't respond, force move to next question
  armQuestionTimer(qIndex, q);

  try {
    await chrome.tabs.sendMessage(collectionState.activeTabId, {
      action: 'ASK_RUFUS',
      payload: {
        question: q.question,
        category: q.category,
        asin: collectionState.asins[collectionState.currentAsinIndex],
        questionIndex: qIndex,
        settings: collectionState.settings,
      },
    });
  } catch (err) {
    if (collectionState._questionTimer) clearTimeout(collectionState._questionTimer);
    addLog('error', `发送问题失败: ${err.message}`);
    handleAssistantError({
      asin: collectionState.asins[collectionState.currentAsinIndex],
      question: q.question,
      category: q.category,
      error: err.message,
    });
  }
}

function processNext() {
  if (!collectionState.isRunning || collectionState.isPaused) return;
  askCurrentQuestion();
}

// ===== ANSWER PROCESSING（不翻译 / 免费翻译 / 大模型）=====
/**
 * 解析回答处理模式，兼容旧版 boolean translateToChinese。
 * @returns {'none'|'free'|'llm'}
 */
function resolveTranslationMode(settings) {
  if (settings.translationMode) return settings.translationMode;
  if (typeof settings.translateToChinese !== 'undefined') {
    return settings.translateToChinese ? 'free' : 'none';
  }
  return 'free';
}

/**
 * 按配置处理一条回答：none 原样返回 / free 免费翻译 / llm 大模型翻译。
 */
async function processAnswer(text, settings) {
  if (!text || !text.trim()) return text;
  const mode = resolveTranslationMode(settings);
  if (mode === 'none') return text;
  if (mode === 'llm') return translateWithLlm(text, settings.llm || {});
  return translateToChinese(text);
}

/**
 * 用大模型翻译/分析。provider=openai 走 OpenAI 兼容 /chat/completions
 * （覆盖本地 Ollama、LM Studio、DeepSeek、OpenRouter 等）；provider=anthropic 走
 * Anthropic /v1/messages。本地服务可不填 apiKey。
 */
async function translateWithLlm(text, llm) {
  const provider = llm.provider || 'openai';
  const baseUrl = String(llm.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(llm.model || '').trim();
  const apiKey = String(llm.apiKey || '').trim();
  const targetLang = String(llm.targetLang || '中文').trim() || '中文';

  if (!baseUrl) throw new Error('未配置大模型 Base URL');
  if (!model) throw new Error('未配置模型名');

  const system = `你是专业的电商翻译。把用户提供的英文内容准确翻译成${targetLang}，保留要点、列表和换行。只输出译文，不要任何解释或前缀。`;

  if (provider === 'anthropic') {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const out = (data.content || []).map((c) => c.text || '').join('').trim();
    if (!out) throw new Error('Anthropic 返回空内容');
    return out;
  }

  // OpenAI 兼容（含本地服务）
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const out = data && data.choices && data.choices[0] && data.choices[0].message
    && String(data.choices[0].message.content || '').trim();
  if (!out) throw new Error('LLM 返回空内容');
  return out;
}

// ===== TRANSLATION（免费）=====
/**
 * Translate text to Chinese.
 * Uses MyMemory API as primary (reliable in extension context).
 * Falls back to Google Translate unofficial endpoint if MyMemory fails.
 * @param {string} text
 * @returns {Promise<string>}
 */
async function translateToChinese(text) {
  if (!text || !text.trim()) return text;

  // MyMemory has a 500-char limit per request, so chunk the text
  const CHUNK_SIZE = 480;
  const sentences = splitTextForTranslation(text, CHUNK_SIZE);

  const translated = [];
  for (const chunk of sentences) {
    const result = await translateChunkWithFallback(chunk);
    translated.push(result);
  }
  return translated.join(' ');
}

/**
 * Split text into sentence-aware chunks that won't exceed maxLen chars.
 */
function splitTextForTranslation(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  // Split on sentence boundaries first
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > maxLen) {
      if (current) chunks.push(current.trim());
      // If a single sentence is too long, split by words
      if (s.length > maxLen) {
        const words = s.split(' ');
        let wordChunk = '';
        for (const w of words) {
          if ((wordChunk + ' ' + w).length > maxLen) {
            if (wordChunk) chunks.push(wordChunk.trim());
            wordChunk = w;
          } else {
            wordChunk += (wordChunk ? ' ' : '') + w;
          }
        }
        if (wordChunk) current = wordChunk;
        else current = '';
      } else {
        current = s;
      }
    } else {
      current += (current ? ' ' : '') + s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Try MyMemory first, then Google Translate as fallback.
 */
async function translateChunkWithFallback(text) {
  // --- Primary: MyMemory (free, CORS-friendly, no key needed) ---
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`);
    const data = await response.json();
    if (data.responseStatus === 200 && data.responseData && data.responseData.translatedText) {
      const result = data.responseData.translatedText;
      // MyMemory returns original text when quota exceeded
      if (result && result !== text && !/quota/i.test(result)) {
        return result;
      }
      throw new Error('MyMemory quota exceeded or no translation');
    }
    throw new Error(`MyMemory status ${data.responseStatus}: ${data.responseDetails}`);
  } catch (primaryErr) {
    console.warn('[Alexa洞察] MyMemory 失败，尝试 Google 备用:', primaryErr.message);
  }

  // --- Fallback: Google Translate unofficial endpoint ---
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Translate HTTP ${response.status}`);
    const data = await response.json();
    const translated = data[0]
      .filter((item) => item && item[0])
      .map((item) => item[0])
      .join('');
    if (translated) return translated;
    throw new Error('Google Translate empty response');
  } catch (fallbackErr) {
    console.error('[Alexa洞察] 所有翻译接口失败，保留原文:', fallbackErr.message);
    return text;
  }
}

// ===== RESPONSE HANDLERS =====
async function handleAssistantResponse(payload) {
  if (isStaleQuestionPayload(payload)) return;

  // Clear safety timeout
  if (collectionState._questionTimer) clearTimeout(collectionState._questionTimer);

  // 始终保留英文原文；answer 为最终展示值（可能被翻译/处理）
  const answerEn = payload.answer || '';
  let answer = answerEn;

  // 按配置处理回答：none 原文 / free 免费翻译 / llm 大模型
  const mode = resolveTranslationMode(collectionState.settings);
  if (mode !== 'none') {
    try {
      addLog('info', mode === 'llm' ? '正在用大模型处理回答...' : '正在翻译回答...');
      answer = await processAnswer(answerEn, collectionState.settings);
    } catch (e) {
      addLog('warning', `处理失败，保留原文: ${e.message}`);
    }
  }

  const result = {
    asin: payload.asin,
    productTitle: payload.productTitle || '',
    price: payload.price || '',
    category: payload.category,
    question: payload.question,
    answer: answer,
    answerEn: answerEn,
    status: 'success',
    timestamp: new Date().toISOString(),
  };

  collectionState.results.push(result);
  broadcastToPopup({ action: 'RESULT_RECEIVED', payload: result });
  addLog('success', `收到回答 (${answer.slice(0, 40)}...)`);

  collectionState.currentQuestionIndex++;
  persistTaskState(); // Save after every result
  setTimeout(() => processNext(), 1500);
}

function handleAssistantError(payload) {
  if (isStaleQuestionPayload(payload)) return;

  // Clear safety timeout
  if (collectionState._questionTimer) clearTimeout(collectionState._questionTimer);

  const result = {
    asin: payload.asin,
    productTitle: '',
    price: '',
    category: payload.category || '',
    question: payload.question || '',
    answer: `ERROR: ${payload.error}`,
    answerEn: '',
    status: 'error',
    timestamp: new Date().toISOString(),
  };

  collectionState.results.push(result);
  broadcastToPopup({ action: 'RESULT_RECEIVED', payload: result });
  addLog('error', `采集失败: ${payload.error}`);

  collectionState.currentQuestionIndex++;
  persistTaskState(); // Save after every result
  setTimeout(() => processNext(), 1500);
}

// ===== LOGGING (persisted in memory for popup reconnect) =====
function addLog(type, message) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const entry = { type, message, time };
  collectionState.logs.push(entry);
  if (collectionState.logs.length > MAX_LOGS) {
    collectionState.logs = collectionState.logs.slice(-MAX_LOGS);
  }
  broadcastToPopup({ action: 'LOG', payload: entry });
}

// ===== PERSISTENCE =====
function persistTaskState() {
  const stateToStore = { ...collectionState };
  delete stateToStore._questionTimer;
  chrome.storage.local.set({
    apinsightResults: collectionState.results,
    [TASK_STORAGE_KEY]: stateToStore,
  }).catch(() => {});
}

function autoExportCsvIfNeeded() {
  if (collectionState.autoExported || collectionState.results.length === 0) return;

  collectionState.autoExported = true;
  persistTaskState();

  try {
    const csv = buildResultsCsv(collectionState.results);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `alexa-insight-${collectionState.marketplace}-${timestamp}.csv`;
    const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;

    chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        addLog('error', `自动导出 CSV 失败: ${chrome.runtime.lastError.message}`);
        return;
      }
      addLog('success', `已自动导出 CSV: ${filename}`);
    });
  } catch (err) {
    addLog('error', `自动导出 CSV 失败: ${err.message}`);
  }
}

function buildResultsCsv(results) {
  const BOM = '\uFEFF';
  const headers = ['ASIN', 'Product Title', 'Price', 'Category', 'Question', 'Answer', 'Answer (EN)', 'Status', 'Timestamp'];
  const rows = results.map((r) => [
    r.asin || '',
    r.productTitle || '',
    r.price || '',
    r.category || '',
    r.question || '',
    r.answer || '',
    r.answerEn || '',
    r.status || '',
    r.timestamp || '',
  ].map(csvEscape).join(','));

  return BOM + headers.join(',') + '\n' + rows.join('\n');
}

function csvEscape(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function hydrateTaskState() {
  try {
    const data = await chrome.storage.local.get([TASK_STORAGE_KEY, 'apinsightResults']);
    if (data[TASK_STORAGE_KEY]) {
      collectionState = {
        ...collectionState,
        ...data[TASK_STORAGE_KEY],
        results: data[TASK_STORAGE_KEY].results || data.apinsightResults || [],
      };
      delete collectionState._questionTimer;
    } else if (data.apinsightResults) {
      collectionState.results = data.apinsightResults;
    }
  } catch (e) {
    // Keep default state if storage is unavailable.
  }
}

const stateReady = hydrateTaskState().then(() => {
  if (collectionState.isRunning && !collectionState.isPaused) {
    recoverRunningTask();
  }
});

async function recoverRunningTask() {
  if (collectionState.phase === 'navigating' && collectionState.activeTabId) {
    try {
      const tab = await chrome.tabs.get(collectionState.activeTabId);
      if (tab.status === 'complete') {
        scheduleStartQuestions();
      }
    } catch (e) {
      navigateToAsin(collectionState.currentAsinIndex);
    }
    return;
  }

  if (collectionState.phase === 'asking') {
    const q = collectionState.questions[collectionState.currentQuestionIndex];
    if (q) {
      addLog('warning', '后台被浏览器休眠后已恢复，继续等待当前问题');
      armQuestionTimer(collectionState.currentQuestionIndex, q);
    }
  }
}

function armQuestionTimer(qIndex, q) {
  const maxWait = (collectionState.settings.maxWaitTime || 60) + 15;
  if (collectionState._questionTimer) clearTimeout(collectionState._questionTimer);
  collectionState._questionTimer = setTimeout(() => {
    if (!collectionState.isRunning || collectionState.isPaused || collectionState.currentQuestionIndex !== qIndex) return;
    addLog('warning', `问题 ${qIndex + 1} 超时（${maxWait}秒无响应），跳过`);
    handleAssistantError({
      asin: collectionState.asins[collectionState.currentAsinIndex],
      question: q.question,
      questionIndex: qIndex,
      category: q.category,
      error: `后台安全超时（${maxWait}秒）`,
    });
  }, maxWait * 1000);
}

function isStaleQuestionPayload(payload) {
  if (!collectionState.isRunning) return true;
  if (payload.questionIndex !== undefined && payload.questionIndex !== collectionState.currentQuestionIndex) {
    addLog('warning', `忽略迟到的第 ${payload.questionIndex + 1} 个问题结果`);
    return true;
  }
  const currentAsin = collectionState.asins[collectionState.currentAsinIndex];
  if (payload.asin && currentAsin && payload.asin !== currentAsin) {
    addLog('warning', `忽略迟到的 ASIN ${payload.asin} 结果`);
    return true;
  }
  return false;
}

function scheduleStartQuestions() {
  setTimeout(() => {
    if (collectionState.isRunning && !collectionState.isPaused && collectionState.phase === 'navigating') {
      startQuestionsForCurrentAsin();
    }
  }, 3000);
}

// ===== BROADCAST HELPERS =====
function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastProgress() {
  const totalQ = collectionState.questions.length * collectionState.asins.length;
  const completedQ = collectionState.currentAsinIndex * collectionState.questions.length + collectionState.currentQuestionIndex;

  broadcastToPopup({
    action: 'PROGRESS_UPDATE',
    payload: {
      completedAsins: collectionState.currentAsinIndex,
      totalAsins: collectionState.asins.length,
      completedQuestions: completedQ,
      totalQuestions: totalQ,
      currentAsin: collectionState.asins[collectionState.currentAsinIndex],
      currentQuestion: collectionState.questions[collectionState.currentQuestionIndex]?.question || '',
    },
  });
}

// Tab close handler
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === collectionState.activeTabId && collectionState.isRunning) {
    collectionState.activeTabId = null;
    addLog('warning', '采集标签页被关闭');
    stopCollection();
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  stateReady.then(() => {
    if (tabId === collectionState.activeTabId && collectionState.isRunning && collectionState.phase === 'navigating') {
      scheduleStartQuestions();
    }
  });
});

// ===== OPEN AS SIDE PANEL =====
// 点击工具栏图标时，在浏览器右侧打开原生侧边栏（Chrome 114+）。
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
