(function () {
  'use strict';

  if (window.__apinsightNetHook) return;
  window.__apinsightNetHook = true;

  const SOURCE = 'apinsight-net';
  let requestSeq = 0;

  const KEYWORDS = [
    'rufus',
    'alexa',
    'conversation',
    'converse',
    'chat',
    'assistant',
    'utterance',
    'stream',
  ];

  const IGNORE_URL_PATTERNS = [
    /\/nav\/ajax\/wishlist/i,
    /\/customer-preferences\//i,
    /\/hz\/profilepicker\//i,
    /\/gp\/product\/ajax\/billOfMaterial/i,
    /amazon-adsystem\.com/i,
    /unagi(?:-na)?\.amazon\.com/i,
    /m\.media-amazon\.com/i,
  ];

  function post(type, payload) {
    const message = {
      source: SOURCE,
      type,
      payload: {
        frameUrl: window.location.href,
        ...payload,
      },
    };
    window.postMessage(message, '*');
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, '*');
    }
  }

  function stringifyBody(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const parts = [];
      body.forEach((value, key) => {
        parts.push(`${key}=${typeof value === 'string' ? value : '[file]'}`);
      });
      return parts.join('&');
    }
    try {
      return JSON.stringify(body);
    } catch (e) {
      return '';
    }
  }

  function requestLooksRelevant(url, bodyText) {
    const u = url || '';
    if (IGNORE_URL_PATTERNS.some((pattern) => pattern.test(u))) return false;
    // Rufus → Alexa for Shopping（2026-05 改名合并）。两者的对话端点都走
    // /cl/streaming 风格；命中其一即捕获，避免被无关的 rufus/alexa 静态资源干扰。
    if (/\/(rufus|alexa)\//i.test(u)) {
      return /(streaming|\/cl\/|conversation|converse|chat)/i.test(u);
    }
    const haystack = `${u}\n${bodyText || ''}`.toLowerCase();
    return KEYWORDS.some((keyword) => haystack.includes(keyword));
  }

  function chunkLooksRelevant(text) {
    if (!text || text.length < 8) return false;
    const lower = text.toLowerCase();
    return KEYWORDS.some((keyword) => lower.includes(keyword))
      || /"((?:text|content|answer|message|completion|delta|outputText|utterance))"\s*:/.test(text);
  }

  function responseLooksRelevant(text) {
    if (!text || text.length < 8) return false;
    return /\brufus\b/i.test(text)
      || /"((?:answer|completion|delta|outputText|utterance|plainText|markdown))"\s*:/.test(text);
  }

  async function streamResponse(id, url, response) {
    const clone = response.clone();

    if (!clone.body || !clone.body.getReader) {
      const text = await clone.text();
      if (chunkLooksRelevant(text)) {
        post('complete', { id, url, text });
      }
      return;
    }

    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let sawRelevantChunk = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;

      if (sawRelevantChunk || chunkLooksRelevant(chunk) || chunkLooksRelevant(raw)) {
        sawRelevantChunk = true;
        post('chunk', { id, url, text: chunk });
      }
    }

    raw += decoder.decode();
    if (sawRelevantChunk || chunkLooksRelevant(raw)) {
      post('complete', { id, url });
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function apinsightFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const bodyText = stringifyBody(init?.body);
    const shouldWatch = requestLooksRelevant(url, bodyText);
    const id = shouldWatch ? ++requestSeq : 0;

    if (shouldWatch) {
      post('request', { id, url, body: bodyText, method: init?.method || 'GET' });
    }

    const response = await originalFetch.apply(this, arguments);

    if (shouldWatch || requestLooksRelevant(response.url || url, bodyText)) {
      const responseId = id || ++requestSeq;
      streamResponse(responseId, response.url || url, response).catch((error) => {
        post('error', { id: responseId, url: response.url || url, error: error.message });
      });
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function apinsightOpen(method, url) {
    this.__apinsightXhr = { method, url: String(url || ''), id: 0, lastTextLength: 0 };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function apinsightSend(body) {
    const hook = this.__apinsightXhr || {};
    const bodyText = stringifyBody(body);
    const shouldWatch = requestLooksRelevant(hook.url, bodyText);

    if (shouldWatch) {
      hook.id = ++requestSeq;
      post('request', { id: hook.id, url: hook.url, body: bodyText, method: hook.method || 'GET' });
    }

    this.addEventListener('readystatechange', () => {
      if (this.readyState !== XMLHttpRequest.LOADING || this.responseType) return;
      const text = this.responseText || '';
      if (!hook.id && responseLooksRelevant(text) && !IGNORE_URL_PATTERNS.some((pattern) => pattern.test(hook.url || ''))) hook.id = ++requestSeq;
      if (hook.id && chunkLooksRelevant(text)) {
        const delta = text.slice(hook.lastTextLength);
        hook.lastTextLength = text.length;
        if (delta) post('chunk', { id: hook.id, url: hook.url, text: delta });
      }
    });

    this.addEventListener('loadend', () => {
      if (this.responseType && this.responseType !== 'text') return;
      const text = this.responseText || '';
      if (!hook.id && responseLooksRelevant(text) && !IGNORE_URL_PATTERNS.some((pattern) => pattern.test(hook.url || ''))) hook.id = ++requestSeq;
      if (hook.id && chunkLooksRelevant(text)) {
        const delta = text.slice(hook.lastTextLength);
        hook.lastTextLength = text.length;
        post('complete', { id: hook.id, url: hook.url, text: delta });
      }
    });

    return originalSend.apply(this, arguments);
  };

  post('ready', {});
})();
