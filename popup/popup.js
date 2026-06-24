/**
 * Popup Controller - Alexa 产品洞察 · WaytoAIC
 * Handles UI interactions, state management, and communication with background/content scripts.
 */

(function () {
  'use strict';

  // ===== STATE =====
  const state = {
    marketplace: 'US',
    asins: [],
    selectedCategories: new Set(),
    customQuestions: [],
    results: [],
    isRunning: false,
    isPaused: false,
    currentAsinIndex: -1,
    currentQuestionIndex: -1,
    settings: {
      stableChecks: 3,
      checkInterval: 1.5,
      maxWaitTime: 60,
      selectors: {},
      autoScroll: true,
      autoRetry: true,
      collectMetadata: true,
      translationMode: 'free', // 'none' | 'free' | 'llm'
      llm: { provider: 'openai', baseUrl: '', apiKey: '', model: '', targetLang: '中文' },
    },
  };

  // ===== DOM REFERENCES =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ===== INIT =====
  document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initMarketplace();
    initAsinInput();
    initCategories();
    initCollapsible();
    initSettings();
    initActions();
    loadSavedConfig();
    listenForMessages();
    restoreFromBackground();
  });

  // ===== COLLAPSIBLE PREVIEW =====
  function initCollapsible() {
    $('#togglePreview').addEventListener('click', () => {
      const label = $('#togglePreview');
      const list = $('#questionsList');
      label.classList.toggle('expanded');
      list.classList.toggle('collapsed');
    });
  }

  // ===== TABS =====
  function initTabs() {
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach((t) => t.classList.remove('active'));
        $$('.tab-content').forEach((c) => c.classList.remove('active'));
        tab.classList.add('active');
        $(`#tab-${tab.dataset.tab}`).classList.add('active');
      });
    });
  }

  // ===== MARKETPLACE =====
  function initMarketplace() {
    $$('.marketplace-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.marketplace-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.marketplace = btn.dataset.market;
      });
    });
  }

  // ===== ASIN INPUT =====
  function initAsinInput() {
    const input = $('#asinInput');
    let debounceTimer;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => parseAndDisplayAsins(), 300);
    });
  }

  function parseAndDisplayAsins() {
    const raw = $('#asinInput').value;
    const asins = AsinParser.parse(raw);
    state.asins = asins;
    $('#asinCount').textContent = asins.length;

    const container = $('#asinTags');
    container.innerHTML = '';
    asins.forEach((asin) => {
      const tag = document.createElement('div');
      tag.className = 'asin-tag';
      tag.innerHTML = `<span>${asin}</span><span class="remove" data-asin="${asin}">&times;</span>`;
      container.appendChild(tag);
    });

    container.querySelectorAll('.remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const asin = btn.dataset.asin;
        const input = $('#asinInput');
        input.value = input.value.replace(new RegExp(asin, 'gi'), '').replace(/,\s*,/g, ',').replace(/^,\s*|,\s*$/g, '').trim();
        parseAndDisplayAsins();
      });
    });
  }

  // ===== CATEGORIES =====
  function initCategories() {
    const grid = $('#categoriesGrid');
    Object.values(PRESET_QUESTIONS).forEach((cat) => {
      const card = document.createElement('div');
      card.className = 'category-card';
      card.dataset.catId = cat.id;
      card.innerHTML = `
        <span class="cat-icon">${cat.icon}</span>
        <span class="cat-name">${cat.nameShort}</span>
        <span class="cat-count">${cat.questions.length}Q</span>
      `;
      card.addEventListener('click', () => toggleCategory(cat.id, card));
      grid.appendChild(card);
    });
  }

  function toggleCategory(catId, card) {
    if (state.selectedCategories.has(catId)) {
      state.selectedCategories.delete(catId);
      card.classList.remove('selected');
    } else {
      state.selectedCategories.add(catId);
      card.classList.add('selected');
    }
    updateQuestionsPreview();
  }

  function updateQuestionsPreview() {
    const preview = $('#questionsPreview');
    const list = $('#questionsList');
    const allQuestions = getSelectedQuestions();

    if (allQuestions.length === 0) {
      preview.style.display = 'none';
      return;
    }

    preview.style.display = 'block';
    $('#totalQuestionCount').textContent = allQuestions.length;
    list.innerHTML = '';

    let qNum = 1;
    state.selectedCategories.forEach((catId) => {
      const cat = PRESET_QUESTIONS[catId];
      if (!cat) return;

      const title = document.createElement('div');
      title.className = 'question-group-title';
      title.textContent = cat.name;
      list.appendChild(title);

      cat.questions.forEach((q) => {
        const item = document.createElement('div');
        item.className = 'question-item';
        item.innerHTML = `
          <span class="q-num">${qNum}.</span>
          <span class="q-text">${q}</span>
        `;
        list.appendChild(item);
        qNum++;
      });
    });
  }

  function getSelectedQuestions() {
    const questions = [];
    state.selectedCategories.forEach((catId) => {
      const cat = PRESET_QUESTIONS[catId];
      if (cat) {
        cat.questions.forEach((q) => {
          questions.push({ category: cat.nameShort, categoryId: catId, question: q });
        });
      }
    });

    // Add custom questions
    const custom = $('#customQuestions').value.trim();
    if (custom) {
      custom.split('\n').filter((l) => l.trim()).forEach((q) => {
        questions.push({ category: 'Custom', categoryId: 'custom', question: q.trim() });
      });
    }

    return questions;
  }

  // ===== SETTINGS =====
  function initSettings() {
    $('#settingsBtn').addEventListener('click', () => $('#settingsModal').classList.add('show'));
    $('#closeSettingsBtn').addEventListener('click', () => $('#settingsModal').classList.remove('show'));
    $('#settingsModal').addEventListener('click', (e) => {
      if (e.target === $('#settingsModal')) $('#settingsModal').classList.remove('show');
    });

    $('#saveSettingsBtn').addEventListener('click', saveSettings);
    $('#resetSelectorsBtn').addEventListener('click', resetSelectors);
    $('#translationMode').addEventListener('change', syncLlmConfigVisibility);
    $('#testLlmBtn').addEventListener('click', testLlmConnection);
  }

  function syncLlmConfigVisibility() {
    $('#llmConfig').style.display = $('#translationMode').value === 'llm' ? 'block' : 'none';
  }

  function readLlmFromUi() {
    return {
      provider: $('#llmProvider').value,
      baseUrl: $('#llmBaseUrl').value.trim(),
      apiKey: $('#llmApiKey').value.trim(),
      model: $('#llmModel').value.trim(),
      targetLang: $('#llmTargetLang').value.trim() || '中文',
    };
  }

  function testLlmConnection() {
    const result = $('#llmTestResult');
    const llm = readLlmFromUi();
    if (!llm.baseUrl || !llm.model) {
      result.textContent = '请先填 Base URL 和模型名';
      return;
    }
    result.textContent = '测试中...';
    chrome.runtime.sendMessage({ action: 'TEST_LLM', payload: { llm } }, (resp) => {
      if (chrome.runtime.lastError) {
        result.textContent = '✗ ' + chrome.runtime.lastError.message;
        return;
      }
      if (resp && resp.ok) result.textContent = '✓ 连接成功，示例译文：' + (resp.text || '').slice(0, 40);
      else result.textContent = '✗ ' + ((resp && resp.error) || '未知错误');
    });
  }

  function syncTranslationUiFromState() {
    const s = state.settings;
    if (s.translationMode) $('#translationMode').value = s.translationMode;
    const llm = s.llm || {};
    if (llm.provider) $('#llmProvider').value = llm.provider;
    if (typeof llm.baseUrl === 'string') $('#llmBaseUrl').value = llm.baseUrl;
    if (typeof llm.apiKey === 'string') $('#llmApiKey').value = llm.apiKey;
    if (typeof llm.model === 'string') $('#llmModel').value = llm.model;
    if (llm.targetLang) $('#llmTargetLang').value = llm.targetLang;
    syncLlmConfigVisibility();
  }

  function saveSettings() {
    state.settings.selectors = {
      rufusBtn: $('#selectorRufusBtn').value,
      rufusInput: $('#selectorRufusInput').value,
      rufusSend: $('#selectorRufusSend').value,
      rufusResponse: $('#selectorRufusResponse').value,
    };
    state.settings.autoScroll = $('#autoScroll').checked;
    state.settings.autoRetry = $('#autoRetry').checked;
    state.settings.collectMetadata = $('#collectMetadata').checked;
    state.settings.translationMode = $('#translationMode').value;
    state.settings.llm = readLlmFromUi();

    chrome.storage.local.set({ apinsightSettings: state.settings });
    $('#settingsModal').classList.remove('show');
    addLog('info', '设置已保存');
  }

  function resetSelectors() {
    $('#selectorRufusBtn').value = '#dpx-nice-widget-container button.ask-pill, .ask-pill';
    $('#selectorRufusInput').value = '#rufus-text-area, #rufus-container-main-view textarea';
    $('#selectorRufusSend').value = '#rufus-container-main-view button[type="submit"]';
    $('#selectorRufusResponse').value = '#rufus-container-main-view [id^="interaction"], [id^="interaction"]';
  }

  function initActions() {
    $('#startBtn').addEventListener('click', startCollection);
    $('#pauseBtn').addEventListener('click', togglePause);
    $('#stopBtn').addEventListener('click', stopCollection);
    $('#saveConfigBtn').addEventListener('click', saveConfig);
    $('#clearTaskBtn').addEventListener('click', clearTask);
    $('#clearLogBtn').addEventListener('click', () => {
      $('#logEntries').innerHTML = '<div class="log-entry info"><span class="log-time">--:--:--</span><span class="log-msg">日志已清除</span></div>';
    });

    // Export buttons
    $('#exportCsvBtn').addEventListener('click', () => exportResults('csv'));
    $('#exportJsonBtn').addEventListener('click', () => exportResults('json'));
    $('#exportExcelBtn').addEventListener('click', () => exportResults('csv'));
    $('#clearResultsBtn').addEventListener('click', clearResults);

    // Result filters
    $('#resultAsinFilter').addEventListener('change', filterResults);
    $('#resultCategoryFilter').addEventListener('change', filterResults);
  }

  function clearTask() {
    if (state.isRunning) {
      if (!confirm('任务正在运行中，确定要清除吗？')) return;
      chrome.runtime.sendMessage({ action: 'STOP_COLLECTION' });
    }
    chrome.runtime.sendMessage({ action: 'CLEAR_TASK' });
    state.isRunning = false;
    state.isPaused = false;
    state.results = [];
    $('#startBtn').disabled = false;
    $('#pauseBtn').disabled = true;
    $('#stopBtn').disabled = true;
    $('#overallPct').textContent = '0%';
    $('#overallBar').style.width = '0%';
    $('#completedAsins').textContent = '0';
    $('#completedQuestions').textContent = '0';
    $('#totalAnswers').textContent = '0';
    $('#currentAsin').textContent = '等待开始...';
    $('#currentQuestion').textContent = '-';
    $('#logEntries').innerHTML = '<div class="log-entry info"><span class="log-time">--:--:--</span><span class="log-msg">任务已清除，准备就绪</span></div>';
    $('#emptyResults').style.display = 'block';
    $('#resultsTableWrapper').style.display = 'none';
    $('#exportBar').style.display = 'none';
    // Switch to setup tab
    $$('.tab')[0].click();
    addLog('info', '所有任务数据已清除');
  }

  function clearResults() {
    if (state.results.length === 0) {
      addLog('info', '当前没有可清除的结果');
      return;
    }

    if (state.isRunning && !confirm('采集正在运行中，确定要清除已采集结果吗？后续新结果仍会继续加入。')) {
      return;
    }

    state.results = [];
    chrome.runtime.sendMessage({ action: 'CLEAR_RESULTS' }, () => {
      if (chrome.runtime.lastError) {
        addLog('error', `清除结果失败: ${chrome.runtime.lastError.message}`);
        return;
      }
      renderResults();
      $('#totalAnswers').textContent = '0';
      addLog('success', '采集结果已清除');
    });
  }

  function startCollection() {
    console.log('[Alexa洞察] startCollection called');
    const questions = getSelectedQuestions();

    if (state.asins.length === 0) {
      addLog('error', '请输入至少一个 ASIN');
      // Also switch to progress tab so user can see the error
      $$('.tab')[1].click();
      return;
    }
    if (questions.length === 0) {
      addLog('error', '请选择至少一个问题分类');
      $$('.tab')[1].click();
      return;
    }

    state.isRunning = true;
    state.isPaused = false;
    state.results = [];
    state.currentAsinIndex = 0;
    state.currentQuestionIndex = 0;

    // Read smart detection settings
    state.settings.stableChecks = parseInt($('#stableChecks').value) || 3;
    state.settings.checkInterval = parseFloat($('#checkInterval').value) || 1.5;
    state.settings.maxWaitTime = parseInt($('#maxWaitTime').value) || 60;

    // Update UI
    $('#startBtn').disabled = true;
    $('#pauseBtn').disabled = false;
    $('#stopBtn').disabled = false;

    // Switch to progress tab
    $$('.tab')[1].click();

    addLog('info', `开始采集: ${state.asins.length} 个 ASIN, ${questions.length} 个问题`);

    const payload = {
      marketplace: state.marketplace,
      asins: state.asins,
      questions: questions,
      settings: state.settings,
    };
    console.log('[Alexa洞察] Sending START_COLLECTION', payload);

    // Send task to background script
    try {
      chrome.runtime.sendMessage({
        action: 'START_COLLECTION',
        payload: payload,
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Alexa洞察] sendMessage error:', chrome.runtime.lastError);
          addLog('error', `发送消息失败: ${chrome.runtime.lastError.message}`);
          return;
        }
        console.log('[Alexa洞察] START_COLLECTION response:', response);
        addLog('info', '任务已发送到后台，正在打开 Amazon 页面...');
      });
    } catch (err) {
      console.error('[Alexa洞察] startCollection error:', err);
      addLog('error', `启动失败: ${err.message}`);
    }
  }

  function togglePause() {
    state.isPaused = !state.isPaused;
    const btn = $('#pauseBtn');
    if (state.isPaused) {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> 继续`;
      addLog('warning', '采集已暂停');
    } else {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> 暂停`;
      addLog('info', '采集已继续');
    }
    chrome.runtime.sendMessage({ action: state.isPaused ? 'PAUSE_COLLECTION' : 'RESUME_COLLECTION' });
  }

  function stopCollection() {
    state.isRunning = false;
    state.isPaused = false;
    $('#startBtn').disabled = false;
    $('#pauseBtn').disabled = true;
    $('#stopBtn').disabled = true;
    addLog('warning', '采集已停止');
    chrome.runtime.sendMessage({ action: 'STOP_COLLECTION' });
  }

  // ===== PROGRESS UPDATES =====
  function updateProgress(data) {
    const { completedAsins, totalAsins, completedQuestions, totalQuestions, currentAsin, currentQuestion } = data;

    const pct = totalQuestions > 0 ? Math.round((completedQuestions / totalQuestions) * 100) : 0;
    $('#overallPct').textContent = `${pct}%`;
    $('#overallBar').style.width = `${pct}%`;
    $('#completedAsins').textContent = completedAsins;
    $('#completedQuestions').textContent = completedQuestions;
    $('#totalAnswers').textContent = state.results.length;
    if (currentAsin) $('#currentAsin').textContent = currentAsin;
    if (currentQuestion) $('#currentQuestion').textContent = currentQuestion;
  }

  // ===== RESULTS =====
  function addResult(result) {
    state.results.push(result);
    renderResults();
  }

  function renderResults() {
    if (state.results.length === 0) {
      $('#emptyResults').style.display = 'block';
      $('#resultsTableWrapper').style.display = 'none';
      $('#exportBar').style.display = 'none';
      return;
    }

    $('#emptyResults').style.display = 'none';
    $('#resultsTableWrapper').style.display = 'block';
    $('#exportBar').style.display = 'flex';

    // Update filters
    const asinFilter = $('#resultAsinFilter');
    const catFilter = $('#resultCategoryFilter');
    const asinSet = new Set(state.results.map((r) => r.asin));
    const catSet = new Set(state.results.map((r) => r.category));

    asinFilter.innerHTML = '<option value="all">全部 ASIN</option>';
    asinSet.forEach((a) => {
      asinFilter.innerHTML += `<option value="${a}">${a}</option>`;
    });
    catFilter.innerHTML = '<option value="all">全部分类</option>';
    catSet.forEach((c) => {
      catFilter.innerHTML += `<option value="${c}">${c}</option>`;
    });

    filterResults();
  }

  function filterResults() {
    const asinVal = $('#resultAsinFilter').value;
    const catVal = $('#resultCategoryFilter').value;

    let filtered = state.results;
    if (asinVal !== 'all') filtered = filtered.filter((r) => r.asin === asinVal);
    if (catVal !== 'all') filtered = filtered.filter((r) => r.category === catVal);

    const tbody = $('#resultsBody');
    tbody.innerHTML = '';
    filtered.forEach((r) => {
      const statusClass = r.status === 'success' ? 'success' : r.status === 'error' ? 'error' : 'pending';
      const statusText = r.status === 'success' ? '✓ 成功' : r.status === 'error' ? '✗ 失败' : '⏳ 等待';

      // 主行（点击展开详情）
      const tr = document.createElement('tr');
      tr.className = 'result-row';
      tr.appendChild(makeCell(r.asin || ''));
      tr.appendChild(makeCell(r.category || ''));
      tr.appendChild(makeCell(truncate(r.question || '', 34), r.question));
      tr.appendChild(makeCell(truncate(r.answer || '-', 42), r.answer));
      const stTd = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `status-badge ${statusClass}`;
      badge.textContent = statusText;
      stTd.appendChild(badge);
      tr.appendChild(stTd);

      // 详情行（全文 + 复制，文本可选中）
      const detailTr = document.createElement('tr');
      detailTr.className = 'result-detail-row';
      detailTr.style.display = 'none';
      const detailTd = document.createElement('td');
      detailTd.colSpan = 5;
      detailTd.appendChild(buildResultDetail(r));
      detailTr.appendChild(detailTd);

      tr.addEventListener('click', () => {
        const open = detailTr.style.display === 'none';
        detailTr.style.display = open ? '' : 'none';
        tr.classList.toggle('expanded', open);
      });

      tbody.appendChild(tr);
      tbody.appendChild(detailTr);
    });
  }

  function makeCell(text, fullTitle) {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (fullTitle && fullTitle.length > text.length) cell.title = fullTitle;
    return cell;
  }

  function buildResultDetail(r) {
    const wrap = document.createElement('div');
    wrap.className = 'result-detail';
    wrap.appendChild(detailBlock('问题 / Question', r.question || '', false));

    const translated = r.answerEn && r.answer && r.answer !== r.answerEn;
    if (translated) {
      wrap.appendChild(detailBlock('回答（译文）', r.answer || '', true));
      wrap.appendChild(detailBlock('回答原文 / Answer (EN)', r.answerEn || '', true));
    } else {
      wrap.appendChild(detailBlock('回答 / Answer', r.answer || '', true));
      if (r.answerEn && r.answerEn !== r.answer) {
        wrap.appendChild(detailBlock('回答原文 / Answer (EN)', r.answerEn, true));
      }
    }
    return wrap;
  }

  function detailBlock(label, text, copyable) {
    const block = document.createElement('div');
    block.className = 'detail-block';

    const head = document.createElement('div');
    head.className = 'detail-head';
    const lab = document.createElement('span');
    lab.className = 'detail-label';
    lab.textContent = label;
    head.appendChild(lab);

    if (copyable && text) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.textContent = '复制';
      btn.addEventListener('click', (e) => { e.stopPropagation(); copyText(text, btn); });
      head.appendChild(btn);
    }
    block.appendChild(head);

    const body = document.createElement('div');
    body.className = 'detail-text';
    body.textContent = text || '—';
    block.appendChild(body);
    return block;
  }

  function copyText(text, btn) {
    const flash = () => {
      const old = btn.textContent;
      btn.textContent = '已复制 ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => fallbackCopy(text, flash));
    } else {
      fallbackCopy(text, flash);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); if (done) done(); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  // ===== EXPORT =====
  function exportResults(format) {
    if (state.results.length === 0) {
      addLog('error', '没有可导出的结果');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let content, mimeType, ext;

    if (format === 'json') {
      content = JSON.stringify({
        exportDate: new Date().toISOString(),
        marketplace: state.marketplace,
        totalAsins: state.asins.length,
        totalQuestions: state.results.length,
        results: state.results,
      }, null, 2);
      mimeType = 'application/json';
      ext = 'json';
    } else {
      // CSV with BOM for Excel compatibility
      const BOM = '\uFEFF';
      const headers = ['ASIN', 'Product Title', 'Price', 'Category', 'Question', 'Answer', 'Answer (EN)', 'Status', 'Timestamp'];
      const rows = state.results.map((r) => [
        r.asin, csvEscape(r.productTitle || ''), csvEscape(r.price || ''),
        csvEscape(r.category), csvEscape(r.question), csvEscape(r.answer || ''),
        csvEscape(r.answerEn || ''),
        r.status, r.timestamp || '',
      ].join(','));
      content = BOM + headers.join(',') + '\n' + rows.join('\n');
      mimeType = 'text/csv;charset=utf-8';
      ext = 'csv';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({
      url: url,
      filename: `alexa-insight-${state.marketplace}-${timestamp}.${ext}`,
      saveAs: true,
    });

    addLog('success', `结果已导出为 ${ext.toUpperCase()} 文件`);
  }

  // ===== PERSISTENCE =====
  function saveConfig() {
    const config = {
      marketplace: state.marketplace,
      selectedCategories: Array.from(state.selectedCategories),
      asinInput: $('#asinInput').value,
      customQuestions: $('#customQuestions').value,
      stableChecks: $('#stableChecks').value,
      checkInterval: $('#checkInterval').value,
      maxWaitTime: $('#maxWaitTime').value,
    };
    chrome.storage.local.set({ apinsightConfig: config });
    addLog('success', '配置已保存');
  }

  function loadSavedConfig() {
    chrome.storage.local.get(['apinsightConfig', 'apinsightSettings', 'apinsightResults'], (data) => {
      if (data.apinsightConfig) {
        const c = data.apinsightConfig;
        // Restore marketplace
        if (c.marketplace) {
          state.marketplace = c.marketplace;
          $$('.marketplace-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.market === c.marketplace);
          });
        }
        // Restore ASINs
        if (c.asinInput) {
          $('#asinInput').value = c.asinInput;
          parseAndDisplayAsins();
        }
        // Restore categories
        if (c.selectedCategories) {
          c.selectedCategories.forEach((catId) => {
            state.selectedCategories.add(catId);
            const card = $(`.category-card[data-cat-id="${catId}"]`);
            if (card) card.classList.add('selected');
          });
          updateQuestionsPreview();
        }
        // Restore custom questions
        if (c.customQuestions) $('#customQuestions').value = c.customQuestions;
        // Restore detection settings
        if (c.stableChecks) $('#stableChecks').value = c.stableChecks;
        if (c.checkInterval) $('#checkInterval').value = c.checkInterval;
        if (c.maxWaitTime) $('#maxWaitTime').value = c.maxWaitTime;
      }

      if (data.apinsightSettings) {
        Object.assign(state.settings, data.apinsightSettings);
        // 向后兼容：老版本只有 boolean translateToChinese
        if (typeof state.settings.translationMode === 'undefined'
            && typeof data.apinsightSettings.translateToChinese !== 'undefined') {
          state.settings.translationMode = data.apinsightSettings.translateToChinese ? 'free' : 'none';
        }
      }
      // 不论有无已存设置，都让 UI 反映当前状态（避免下拉框默认值与实际不一致）
      syncTranslationUiFromState();

      if (data.apinsightResults && data.apinsightResults.length > 0) {
        state.results = data.apinsightResults;
        renderResults();
      }
    });
  }

  // ===== MESSAGE HANDLING =====
  function listenForMessages() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      switch (msg.action) {
        case 'PROGRESS_UPDATE':
          updateProgress(msg.payload);
          break;
        case 'RESULT_RECEIVED':
          addResult(msg.payload);
          break;
        case 'LOG':
          addLog(msg.payload.type, msg.payload.message, msg.payload.time);
          break;
        case 'COLLECTION_COMPLETE':
          state.isRunning = false;
          $('#startBtn').disabled = false;
          $('#pauseBtn').disabled = true;
          $('#stopBtn').disabled = true;
          addLog('success', `采集完成! 共采集 ${state.results.length} 条结果`);
          $$('.tab')[2].click();
          renderResults();
          break;
        case 'COLLECTION_ERROR':
          addLog('error', msg.payload.message);
          break;
      }
    });
  }

  // ===== RESTORE STATE FROM BACKGROUND =====
  function restoreFromBackground() {
    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Alexa洞察] GET_STATE failed:', chrome.runtime.lastError);
        // Fallback: load from storage
        loadResultsFromStorage();
        return;
      }
      if (!response || !response.ok) {
        loadResultsFromStorage();
        return;
      }

      const bg = response.state;

      if (bg.isRunning || bg.isPaused) {
        // Task is running in background, restore UI
        state.isRunning = bg.isRunning;
        state.isPaused = bg.isPaused;
        state.results = bg.results || [];

        $('#startBtn').disabled = true;
        $('#pauseBtn').disabled = false;
        $('#stopBtn').disabled = false;

        if (bg.isPaused) {
          $('#pauseBtn').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> 继续`;
        }

        $$('.tab')[1].click();

        if (bg.logs && bg.logs.length > 0) {
          $('#logEntries').innerHTML = '';
          bg.logs.forEach((log) => addLog(log.type, log.message, log.time));
        }

        updateProgress({
          completedAsins: bg.currentAsinIndex,
          totalAsins: bg.asins.length,
          completedQuestions: bg.currentAsinIndex * bg.totalQuestions + bg.currentQuestionIndex,
          totalQuestions: bg.totalQuestions * bg.asins.length,
          currentAsin: bg.currentAsin,
          currentQuestion: bg.currentQuestion,
        });

        renderResults();
        addLog('info', '已恢复正在运行的任务');
      } else if (bg.results && bg.results.length > 0) {
        // Task finished, background still has results in memory
        state.results = bg.results;
        renderResults();
        $$('.tab')[2].click(); // Switch to results tab
      } else {
        // Background has no results (service worker may have restarted), check storage
        loadResultsFromStorage();
      }
    });
  }

  function loadResultsFromStorage() {
    chrome.storage.local.get(['apinsightResults'], (data) => {
      if (data.apinsightResults && data.apinsightResults.length > 0) {
        state.results = data.apinsightResults;
        renderResults();
        $$('.tab')[2].click(); // Switch to results tab
        addLog('info', `从存储中恢复了 ${data.apinsightResults.length} 条结果`);
      }
    });
  }

  // ===== LOGGING =====
  function addLog(type, message, time) {
    const entries = $('#logEntries');
    if (!time) {
      const now = new Date();
      time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${message}</span>`;
    entries.appendChild(entry);
    entries.scrollTop = entries.scrollHeight;
  }

  // ===== UTILITIES =====
  function pad(n) { return String(n).padStart(2, '0'); }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
  function truncate(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }
  function csvEscape(s) { return `"${String(s).replace(/"/g, '""')}"`; }
})();
