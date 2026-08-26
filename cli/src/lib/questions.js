'use strict';
/**
 * 题目来源层 —— 直接 require 插件的题库文件，零改动复用。
 * data/preset-questions.js 已带 CJS 导出尾巴（:262-264），所以能直接 require。
 *
 * 题目对象形状必须与 popup.js:190 完全一致：
 *   { category: cat.nameShort, categoryId, question }
 * 其中 category 是中文短名（如「核心必问」），会进 CSV 的 Category 列。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRESET_QUESTIONS = require(path.join(REPO_ROOT, 'data', 'preset-questions.js'));

/** 全部分类 id */
function categoryIds() {
  return Object.keys(PRESET_QUESTIONS);
}

/** 供 `accounts list` / `--help` 展示 */
function describeCategories() {
  return categoryIds().map((id) => ({
    id,
    nameShort: PRESET_QUESTIONS[id].nameShort,
    name: PRESET_QUESTIONS[id].name,
    count: PRESET_QUESTIONS[id].questions.length,
  }));
}

/** 展开一个分类为题目对象数组 */
function expandCategory(catId) {
  const cat = PRESET_QUESTIONS[catId];
  if (!cat) throw new Error(`未知分类：${catId}（可用：${categoryIds().join(', ')}）`);
  return cat.questions.map((q) => ({ category: cat.nameShort, categoryId: catId, question: q }));
}

/** 从文件读自定义题目，一行一题 */
function loadCustomFile(filePath) {
  const text = fs.readFileSync(path.resolve(filePath), 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((q) => ({ category: 'Custom', categoryId: 'custom', question: q }));
}

/**
 * 解析 --questions 参数。
 * 取值：'all' | 分类 id 逗号串 | 存在的文件路径
 *
 * 注意 'all' 会包含 summary_all 与各分类之间的重复题 —— 与插件全选行为一致，
 * 不去重，以保证与插件跑出的结果可对照。
 */
function resolveQuestions(spec) {
  if (!spec) throw new Error('必须指定 --questions（分类 id / all / 文件路径）');

  if (spec === 'all') {
    return categoryIds().flatMap(expandCategory);
  }
  if (fs.existsSync(spec) && fs.statSync(spec).isFile()) {
    return loadCustomFile(spec);
  }
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`无法解析 --questions：${spec}`);
  return ids.flatMap(expandCategory);
}

/** 确定性洗牌（同 seed 同结果，便于 resume 后顺序稳定） */
function shuffle(list, seed = 42) {
  const out = list.slice();
  let s = seed >>> 0;
  const rand = () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = {
  PRESET_QUESTIONS,
  categoryIds,
  describeCategories,
  expandCategory,
  loadCustomFile,
  resolveQuestions,
  shuffle,
};
