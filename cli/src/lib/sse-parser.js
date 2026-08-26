'use strict';
/**
 * SSE / 流式响应解析链。
 *
 * ⚠️ SOURCE OF TRUTH: content/content.js:482-712
 * 除 stripHtmlEntities 外，全部函数与插件逐行同构。插件侧改动必须双向同步到这里，
 * 否则 CLI 与插件会解析出不同的答案，`对照验收` 会失败。
 *
 * 唯一改写：stripHtmlEntities 原版依赖 document.createElement('textarea')，
 * Node 无 DOM，改为纯 JS 实体解码（数字实体 + 常见命名实体），不引第三方依赖。
 */

function isAssistantStreamingUrl(url) {
  // 兼容 Alexa for Shopping（原 Rufus）：两者历史上都走 /cl/streaming 风格的 SSE 端点。
  return /\/(rufus|alexa)\/cl\/streaming/i.test(url || '')
    || /\/cl\/streaming/i.test(url || '');
}

function extractAnswerFromAssistantSse(raw, question) {
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

/**
 * ⚠️ 与插件唯一的实现差异：插件用 document.createElement('textarea') 借浏览器解码，
 * Node 无 DOM，这里用纯 JS 等价实现。行为需与浏览器一致：解码数字实体与常见命名实体，
 * 无法识别的实体原样保留。
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019',
  lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', trade: '\u2122',
  reg: '\u00ae', copy: '\u00a9', deg: '\u00b0', middot: '\u00b7',
  bull: '\u2022', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
};

function stripHtmlEntities(text) {
  return String(text == null ? '' : text).replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, entity) => {
      if (entity[0] === '#') {
        const code = entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch (e) {
          return match;
        }
      }
      const named = NAMED_ENTITIES[entity.toLowerCase()];
      return named === undefined ? match : named;
    }
  );
}

function normalizeComparable(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = {
  isAssistantStreamingUrl,
  extractAnswerFromAssistantSse,
  extractSseDataPayloads,
  collectAssistantPatchText,
  buildAnswerFromTextPatches,
  extractAnswerFromNetworkText,
  splitStreamSegments,
  tryParseJson,
  collectRegexTextCandidates,
  collectTextCandidates,
  isPreferredTextKey,
  cleanCandidateText,
  isUsefulAnswerText,
  isRelatedQuestionText,
  stripHtmlEntities,
  normalizeComparable,
};
