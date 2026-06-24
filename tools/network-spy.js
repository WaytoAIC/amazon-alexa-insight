/**
 * Alexa for Shopping —— 网络抓包侦测器（粘贴进 DevTools 控制台运行）
 *
 * 用途：在真实亚马逊页面上，捕获 Alexa/Rufus 提问时的真实接口 URL、请求体、
 *       以及流式响应（SSE）样本。品牌无关 —— 即使亚马逊改了名字/路径也能抓到。
 *
 * 用法：
 *   1) 打开一个亚马逊商品页（amazon.com，已登录美国账号），按 F12 → Console
 *   2) 把本文件全部内容粘贴进去回车
 *   3) 用一次 Alexa（顶部搜索栏问一句，或选中商品文字点 "Ask Alexa"），等它答完
 *   4) 运行： copy(JSON.stringify({cap: window.__cap, urls: window.__allUrls}, null, 2))
 *   5) 把剪贴板内容粘贴回对话给我
 */
(() => {
  if (window.__capInstalled) {
    console.log('[CAP] 已安装。直接去用 Alexa 提问。结束后运行：\n  copy(JSON.stringify({cap: window.__cap, urls: window.__allUrls}, null, 2))');
    return;
  }
  window.__capInstalled = true;
  window.__cap = [];       // 命中的"疑似聊天"请求 + 响应样本
  window.__allUrls = [];   // 所有请求的 method+url（轻量，用来兜底发现新端点）

  const MAX = 6000;
  const hot = (u) => /stream|chat|assist|alexa|rufus|conversat|convers|message|ask|copilot|agent|cl\//i.test(u || '');
  const sample = (o) => { window.__cap.push(o); console.log('%c[CAP]', 'color:#e47911;font-weight:bold', o.method, o.url); };

  // --- fetch ---
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = (typeof input === 'string' ? input : input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    window.__allUrls.push(method + ' ' + url);
    let reqBody = '';
    try { reqBody = typeof (init && init.body) === 'string' ? init.body : (init && init.body) ? '[non-string body]' : ''; } catch (e) {}
    const res = await of.apply(this, arguments);
    const ct = (res.headers && res.headers.get('content-type')) || '';
    if (hot(url) || /event-stream|ndjson|x-amz-json/i.test(ct)) {
      res.clone().text()
        .then((t) => sample({ kind: 'fetch', method, url, ct, reqBody: reqBody.slice(0, MAX), respChars: t.length, respSample: t.slice(0, MAX) }))
        .catch(() => {});
    }
    return res;
  };

  // --- XHR ---
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__c = { m, u: String(u || '') }; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const h = this.__c || {};
    window.__allUrls.push((h.m || 'GET') + ' ' + (h.u || ''));
    this.addEventListener('loadend', () => {
      const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
      if (!hot(h.u) && !/event-stream|ndjson/i.test(ct)) return;
      let t = ''; try { t = this.responseText || ''; } catch (e) {}
      sample({ kind: 'xhr', method: h.m, url: h.u, ct, reqBody: (typeof b === 'string' ? b : '').slice(0, MAX), respChars: t.length, respSample: t.slice(0, MAX) });
    });
    return os.apply(this, arguments);
  };

  console.log('%c✅ 网络抓取已启动。现在去用 Alexa 提一个问题，等它答完。', 'color:green;font-weight:bold;font-size:13px');
  console.log('结束后运行： copy(JSON.stringify({cap: window.__cap, urls: window.__allUrls}, null, 2))   再粘贴给我');
})();
