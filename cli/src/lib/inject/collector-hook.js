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

  // ⚠️ 插件用的是 300000，对当前格式是**致命**的：
  // Alexa 的答案是 JSON Patch 流，创建根节点的 `op:add path:"/"` 就在流的最开头。
  // 原实现超限时 slice(-MAX) 保留尾部、丢弃头部 —— 根一没，后续所有 patch 全被跳过，
  // 答案静默变空，主路白等 60 秒后回落 DOM。
  // 实测单题原始流已达 288KB，贴着 300KB 上限；答案越详细越容易触发。
  // 这里放大到 2MB（约 7 倍余量），并显式标记截断，不再静默失败。
  var MAX_NETWORK_RAW_CHARS = 2000000;
  var MAX_KEPT_STREAMS = 8;             // 只留最近若干条，避免长会话累积占内存

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
        // 截断即视为不可用：JSON Patch 流丢头就没法重建，宁可显式报废也不产出空答案
        stream.raw = stream.raw.slice(-MAX_NETWORK_RAW_CHARS);
        stream.truncated = true;
      }
    }
    if (type === 'complete') stream.complete = true;
    stream.updatedAt = Date.now();

    // 内存上限：只保留最近的若干条流
    var ids = Object.keys(store.byId);
    if (ids.length > MAX_KEPT_STREAMS) {
      ids.sort(function (a, b) { return (store.byId[a].touch || store.byId[a].seq) - (store.byId[b].touch || store.byId[b].seq); });
      for (var k = 0; k < ids.length - MAX_KEPT_STREAMS; k++) delete store.byId[ids[k]];
    }
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
          raw: s.raw, complete: s.complete, truncated: !!s.truncated, updatedAt: s.updatedAt,
        });
      }
    }
    return { cursor: store.seq, streams: out };
  };

  window.__apinsightCursor = function () { return store.seq; };
})();
