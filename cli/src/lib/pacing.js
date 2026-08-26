'use strict';
/**
 * 拟人化节奏控制。
 *
 * 插件是固定 1.5s 提下一题 —— 有人盯着时没问题，无人值守下太激进。
 * 这里全部改成区间抖动，并加入长休息与切号静默。
 */

const DEFAULTS = {
  delayQuestion: [4, 9],       // 题间（秒）
  delayAsin: [20, 45],         // ASIN 间（秒）
  delayAccountSwitch: [30, 90],// 切号后静默：同机一分钟内连换账号本身就是可疑模式
  settleAfterLoad: 3,          // 页面 load 后落地等待，复刻 background.js:672-678
  breakEvery: 25,              // 每 N 题长休息
  breakFor: [120, 300],        // 长休息时长（秒）
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uniform([min, max]) {
  return min + Math.random() * (max - min);
}

/** 解析 "4,9" 形式的 CLI 参数 */
function parseRange(spec, fallback) {
  if (!spec) return fallback;
  const parts = String(spec).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`区间参数格式应为 "min,max"（秒），收到：${spec}`);
  }
  if (parts[0] > parts[1]) throw new Error(`区间下界大于上界：${spec}`);
  return parts;
}

class Pacer {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.askedSinceBreak = 0;
  }

  async afterQuestion(log) {
    this.askedSinceBreak++;
    if (this.cfg.breakEvery > 0 && this.askedSinceBreak >= this.cfg.breakEvery) {
      this.askedSinceBreak = 0;
      const secs = uniform(this.cfg.breakFor);
      log?.info?.(`已连续问 ${this.cfg.breakEvery} 题，长休息 ${Math.round(secs)}s`);
      await sleep(secs * 1000);
      return;
    }
    await sleep(uniform(this.cfg.delayQuestion) * 1000);
  }

  async afterAsin() { await sleep(uniform(this.cfg.delayAsin) * 1000); }

  async afterAccountSwitch(log) {
    const secs = uniform(this.cfg.delayAccountSwitch);
    log?.debug?.(`切号静默 ${Math.round(secs)}s`);
    await sleep(secs * 1000);
  }

  async settle() { await sleep(this.cfg.settleAfterLoad * 1000); }
}

module.exports = { Pacer, DEFAULTS, parseRange, uniform, sleep };
