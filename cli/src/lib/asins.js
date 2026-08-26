'use strict';
/**
 * ASIN 输入层 —— 直接 require 插件的解析器，零改动复用。
 * utils/asin-parser.js 已带 CJS 导出尾巴（:141-143）。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const AsinParser = require(path.join(REPO_ROOT, 'utils', 'asin-parser.js'));

/**
 * 解析 --asins 参数：文件路径 或 逗号/换行/空格分隔的 ASIN、Amazon URL 混合串。
 * 解析与去重完全交给插件的 AsinParser.parse。
 */
function resolveAsins(spec) {
  if (!spec) throw new Error('必须指定 --asins（ASIN 串或文件路径）');
  const raw = fs.existsSync(spec) && fs.statSync(spec).isFile()
    ? fs.readFileSync(path.resolve(spec), 'utf8')
    : spec;
  const asins = AsinParser.parse(raw);
  if (!asins.length) throw new Error(`未从输入中解析出任何 ASIN：${spec}`);
  return asins;
}

/** 商品页 URL */
function productUrl(asin, marketplace = 'US') {
  const domain = AsinParser.MARKETPLACES[marketplace];
  if (!domain) {
    throw new Error(`未知站点：${marketplace}（可用：${Object.keys(AsinParser.MARKETPLACES).join(', ')}）`);
  }
  return `https://${domain}/dp/${asin}`;
}

/** 站点首页，用于登录态校验 */
function marketplaceHome(marketplace = 'US') {
  const domain = AsinParser.MARKETPLACES[marketplace];
  if (!domain) throw new Error(`未知站点：${marketplace}`);
  return `https://${domain}/`;
}

module.exports = { AsinParser, resolveAsins, productUrl, marketplaceHome };
