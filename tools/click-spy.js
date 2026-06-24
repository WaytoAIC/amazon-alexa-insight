/**
 * Alexa for Shopping —— 点击侦测器（粘贴进 DevTools 控制台运行）
 *
 * 用途：捕获你实际点击的元素的 CSS 选择器和关键属性，用来重写插件的
 *       入口按钮 / 输入框 / 发送按钮 / 回答容器 选择器。
 *
 * 用法：
 *   1) 亚马逊商品页 F12 → Console，粘贴本文件回车
 *   2) 依次点击：① Alexa 入口  ② 输入框  ③ 发送按钮  ④（答完后）回答气泡
 *      每点一次控制台会打印该元素的 [CLICK] 选择器和属性
 *   3) 运行 __clickSpyOff() 关闭，把所有 [CLICK] 输出复制给我
 */
(() => {
  if (window.__clickSpyOff) { console.log('[CLICK] 已在运行。点击元素即可；结束运行 __clickSpyOff()'); return; }

  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  const selector = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && depth < 6; depth++) {
      if (n.id) { parts.unshift('#' + esc(n.id)); break; }
      let p = n.tagName.toLowerCase();
      const cls = (n.className && typeof n.className === 'string')
        ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + esc(c)).join('')
        : '';
      parts.unshift(p + cls);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };

  const attrs = (el) => {
    const out = {};
    for (const a of el.attributes || []) {
      if (/^(id|class|role|placeholder|type|name)$/.test(a.name) || /^(aria-|data-)/.test(a.name)) out[a.name] = a.value;
    }
    return out;
  };

  const handler = (e) => {
    const el = e.target;
    console.log('%c[CLICK]', 'color:#0a7;font-weight:bold', {
      tag: el.tagName,
      selector: selector(el),
      text: (el.textContent || '').trim().slice(0, 40),
      attrs: attrs(el),
    });
  };

  document.addEventListener('click', handler, true);
  window.__clickSpyOff = () => { document.removeEventListener('click', handler, true); delete window.__clickSpyOff; console.log('[CLICK] 已关闭'); };

  console.log('%c✅ 点击侦测已启动。依次点击：① Alexa 入口 ② 输入框 ③ 发送按钮 ④ 回答气泡。', 'color:green;font-weight:bold;font-size:13px');
  console.log('每点一次会打印它的选择器。结束后运行 __clickSpyOff() 关闭，把 [CLICK] 输出复制给我。');
})();
