'use strict';
/**
 * Cookie-Editor 导出格式 → Playwright context.addCookies() 输入。
 *
 * 纯逻辑，无 Playwright 依赖，便于单测。浏览器侧写入在 commands/accounts.js。
 *
 * 实测输入形态（~/.config/ai-hub/amazon-buyers/buyer-*.json）：
 *   { domain, expires, httpOnly, name, path, sameSite, secure, session, value }
 *
 * 两个必须处理的坑：
 *   1. 所有 cookie 都带 session:true，但同时带有效 expires（2027-02-10）。
 *      必须以 expires 为准、忽略 session 标志 —— 否则登录态活不过浏览器重启，
 *      持久化 profile 直接失效。
 *   2. sameSite 是 Cookie-Editor 的取值（unspecified/no_restriction/strict/lax），
 *      需映射到 Playwright 的 Lax/None/Strict。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/** Cookie-Editor sameSite → Playwright sameSite */
const SAME_SITE_MAP = {
  no_restriction: 'None',
  unspecified: 'Lax',   // Chrome 的默认行为
  lax: 'Lax',
  strict: 'Strict',
  none: 'None',
};

/** 只保留 Amazon 自有域；广告追踪域（.amazon-adsystem.com 等）一律丢弃 */
function isAmazonDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'amazon.com' || d.endsWith('.amazon.com');
}

/** 判定登录态是否完整所需的鉴权 cookie */
const REQUIRED_AUTH_COOKIES = ['x-main', 'at-main', 'sess-at-main', 'ubid-main', 'session-id'];

/**
 * 把一条 Cookie-Editor cookie 映射成 Playwright cookie。
 * 返回 null 表示该条应被丢弃。
 */
function mapCookie(raw, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!raw || !raw.name || !raw.domain) return null;
  if (!isAmazonDomain(raw.domain)) return null;

  let sameSite = SAME_SITE_MAP[String(raw.sameSite || '').toLowerCase()] || 'Lax';
  let secure = Boolean(raw.secure);

  // Chromium 拒绝 SameSite=None 且非 secure 的组合，降级为 Lax 而不是丢弃
  if (sameSite === 'None' && !secure) sameSite = 'Lax';

  // 关键：以 expires 为准，无视 session 标志
  const rawExp = Number(raw.expires);
  const expires = Number.isFinite(rawExp) && rawExp > now ? Math.floor(rawExp) : -1;

  return {
    name: String(raw.name),
    value: String(raw.value == null ? '' : raw.value),
    domain: String(raw.domain),
    path: String(raw.path || '/'),
    expires,
    httpOnly: Boolean(raw.httpOnly),
    secure,
    sameSite,
  };
}

/**
 * 把整份导出映射成 Playwright cookies，并给出统计与告警。
 */
function mapCookies(rawList, opts = {}) {
  const input = Array.isArray(rawList) ? rawList : [];
  const cookies = [];
  let droppedNonAmazon = 0;
  let droppedInvalid = 0;
  let sessionOnly = 0;

  for (const raw of input) {
    if (raw && raw.domain && !isAmazonDomain(raw.domain)) { droppedNonAmazon++; continue; }
    const c = mapCookie(raw, opts);
    if (!c) { droppedInvalid++; continue; }
    if (c.expires === -1) sessionOnly++;
    cookies.push(c);
  }

  const names = new Set(cookies.map((c) => c.name));
  const missingAuth = REQUIRED_AUTH_COOKIES.filter((n) => !names.has(n));

  return {
    cookies,
    stats: { total: input.length, kept: cookies.length, droppedNonAmazon, droppedInvalid, sessionOnly },
    missingAuth,
  };
}

/**
 * 安全校验：拒绝读取位于 git 工作区内的凭据文件。
 * 凭据不该待在仓库里 —— 一次 `git add -A` 就可能推上公网。
 */
function assertOutsideGitRepo(filePath) {
  const abs = path.resolve(filePath);
  let dir = path.dirname(abs);
  const root = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      throw new Error(
        `拒绝读取凭据文件：${abs}\n` +
        `它位于 git 工作区 ${dir} 内。凭据永不进仓 —— 请移到仓库外（凭据统一由 ai-hub 托管：~/.config/ai-hub/amazon-buyers/）后重试。`
      );
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return abs;
}

/**
 * 读取导出文件。支持 .json（首选）与 .rtf（macOS 上用 textutil 转换）。
 * RTF 每行是一个账号：行首为账号凭据前缀（密码/2FA，**不解析、不落盘**），
 * 其后是 [{...}] 的 cookie JSON 数组 —— 只取 JSON 段。
 */
function loadExport(filePath, { line = 1 } = {}) {
  const abs = assertOutsideGitRepo(filePath);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);

  const ext = path.extname(abs).toLowerCase();
  let text;
  if (ext === '.rtf') {
    if (process.platform !== 'darwin') {
      throw new Error('.rtf 仅在 macOS 上受支持（依赖 textutil）；请先转成 .json');
    }
    text = execFileSync('textutil', ['-convert', 'txt', '-stdout', abs], { encoding: 'utf8' });
  } else {
    text = fs.readFileSync(abs, 'utf8');
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);

  // RTF / 混合文本：按行取第 N 个账号的 JSON 段
  const lines = text.split('\n').filter((l) => l.includes('[{'));
  if (!lines.length) throw new Error('未在文件中找到 cookie JSON 数组（形如 [{...}]）');
  const target = lines[line - 1];
  if (!target) throw new Error(`文件只有 ${lines.length} 个账号，取不到第 ${line} 个（--line 从 1 开始）`);

  const s = target.indexOf('[{');
  const e = target.lastIndexOf('}]');
  return JSON.parse(target.slice(s, e + 2));
}

module.exports = {
  SAME_SITE_MAP,
  REQUIRED_AUTH_COOKIES,
  isAmazonDomain,
  mapCookie,
  mapCookies,
  assertOutsideGitRepo,
  loadExport,
};
