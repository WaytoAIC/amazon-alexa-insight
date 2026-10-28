'use strict';
/**
 * 会话隔离：每个 ASIN 必须在一个全新的 Alexa 对话里提问。
 *
 * 2026-10-27 实证（runs/voc-comp-20261027）：Alexa 的对话不随换商品页清空，
 * 甚至跨 run、跨浏览器重启都会延续（持久化 profile + 同一账号）。COSY HOMEER
 * B09M7WWTFP 的第 1 题回答里出现了「the MontVoo jute treads we discussed earlier」——
 * MontVoo 是上一个 run 问的商品。竞品对照时这会把 A 的结论带进 B，静默污染数据集。
 *
 * 这里只放纯函数（可单测）；页面侧的"点 New chat"在 collector.startNewConversation。
 *
 * 两道判据：
 *  1. threadId（确定性）：Alexa SSE 流里有 `event:conversation_metadata` 帧，
 *     data 形如 {"threadId":"..."}。两个不同 ASIN 的回答落在同一 threadId = 串台实锤。
 *  2. 回指措辞（启发式）：对话第一题就说"我们之前聊过 / 前面对比过"= 带着旧上下文。
 *     同一 ASIN 的后续题回指本 ASIN 的前几题是正常的，所以只在第一题、
 *     或新对话未能确认建立时才算数。
 */

/** 回指旧对话的措辞。只收实测出现过或语义等价的说法，宁缺毋滥 —— 误报会让人忽略告警 */
const BACK_REFERENCE_PATTERNS = [
  /\b(?:we|i|you)(?:'ve| have)? (?:discussed|talked about|looked at|compared|mentioned|covered|reviewed)\b[^.?!]{0,40}?\b(?:earlier|before|previously)\b/i,
  /\b(?:discussed|mentioned|compared|covered|reviewed|shown) (?:earlier|previously|before)\b/i,
  /\b(?:the|our) (?:earlier|previous|prior) (?:conversation|comparison|discussion|chat|answer|response)\b/i,
  /\bcomparison from earlier\b/i,
  /\bas (?:i|we) (?:mentioned|noted|said|discussed)(?: (?:earlier|before|previously))?\b/i,
  /\b(?:the )?(?:previous|other) (?:product|item|one) (?:you|we) (?:asked|looked|were looking|discussed)\b/i,
];

/** 从一段 Alexa SSE 原始流里取 threadId；没有则返回 '' */
function extractThreadId(raw) {
  const m = /"threadId"\s*:\s*"([^"]+)"/.exec(String(raw || ''));
  return m ? m[1] : '';
}

/** 命中的回指片段（原文），未命中返回 null */
function findBackReference(text) {
  const t = String(text || '');
  for (const re of BACK_REFERENCE_PATTERNS) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

/**
 * 判断一行回答是否疑似串台。返回原因数组，空数组 = 干净。
 *
 * @param {object} p
 * @param {string} p.asin                 本行 ASIN
 * @param {string} p.answer               回答正文
 * @param {string} [p.threadId]           本行回答所在的 Alexa 对话
 * @param {boolean} p.isFirstInConversation 是否本 ASIN 新对话里的第一题
 * @param {boolean} p.conversationFresh   本 ASIN 开始前是否确认建立了新对话
 * @param {Map<string,string>} [p.threadOwners] threadId → 最先使用它的 ASIN
 */
function detectContextLeak({ asin, answer, threadId, isFirstInConversation, conversationFresh, threadOwners }) {
  const reasons = [];

  const owner = threadId && threadOwners ? threadOwners.get(threadId) : null;
  if (owner && owner !== asin) reasons.push(`shared_thread:${owner}`);

  if (isFirstInConversation || !conversationFresh) {
    const phrase = findBackReference(answer);
    if (phrase) reasons.push(`back_reference:${phrase}`);
  }
  return reasons;
}

module.exports = {
  BACK_REFERENCE_PATTERNS,
  extractThreadId,
  findBackReference,
  detectContextLeak,
};
