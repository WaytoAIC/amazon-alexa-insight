(function () {
  'use strict';
  /**
   * 页面侧流收集器 —— content.js:130-206 的同构移植。
   *
   * 与插件的差异只有一处：插件把流存在 content script 的闭包里，
   * 这里存到 window.__apinsightStreams，好让 Node 侧通过 page.evaluate 按 seq 游标拉增量。
   *
   * 配合 content/network-hook.js（零修改经 addInitScript 注入）使用：
   * 后者 hook fetch/XHR/EventSource 并 postMessage，本脚本负责累积。
   */

  if (window.__apinsightStreamsReady) return;
  window.__apinsightStreamsReady = true;

  var NETWORK_SOURCE = 'apinsight-net';
  var MAX_NETWORK_RAW_CHARS = 300000;   // 与 content.js 一致

  var store = {
    seq: 0,
    byId: Object.create(null),
  };
  window.__apinsightStreams = store;

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== NETWORK_SOURCE) return;

    var type = data.type;
    var payload = data.payload || {};
    if (!payload.id && type !== 'ready') return;
    if (type === 'ready') return;

    var stream = store.byId[payload.id];
    if (!stream) {
      stream = {
        seq: ++store.seq,
        id: payload.id,
        url: payload.url || '',
        frameUrl: payload.frameUrl || '',
        method: payload.method || '',
        body: payload.body || '',
        raw: '',
        complete: false,
        updatedAt: Date.now(),
      };
      store.byId[payload.id] = stream;
    }

    if (payload.url) stream.url = payload.url;
    if (payload.frameUrl) stream.frameUrl = payload.frameUrl;
    if (payload.method) stream.method = payload.method;
    if (payload.body) stream.body = payload.body;
    if (payload.text) {
      stream.raw += payload.text;
      if (stream.raw.length > MAX_NETWORK_RAW_CHARS) {
        stream.raw = stream.raw.slice(-MAX_NETWORK_RAW_CHARS);
      }
    }
    if (type === 'complete') stream.complete = true;
    stream.updatedAt = Date.now();
    // 每次更新都把 seq 抬到最新，Node 侧据此判断"有没有新内容"
    stream.touch = ++store.seq;
  });

  /** Node 侧调用：拉取 touch > cursor 的流 */
  window.__apinsightPullStreams = function (cursor) {
    var out = [];
    var ids = Object.keys(store.byId);
    for (var i = 0; i < ids.length; i++) {
      var s = store.byId[ids[i]];
      if ((s.touch || s.seq) > cursor) {
        out.push({
          id: s.id, seq: s.seq, touch: s.touch || s.seq,
          url: s.url, frameUrl: s.frameUrl, method: s.method,
          raw: s.raw, complete: s.complete, updatedAt: s.updatedAt,
        });
      }
    }
    return { cursor: store.seq, streams: out };
  };

  window.__apinsightCursor = function () { return store.seq; };
})();
