'use strict';
/**
 * 异常页面守卫：人机验证 / 登录失效 / 服务异常 / 商品不存在。
 *
 * 红线：只识别与上报，**绝不尝试绕过或求解验证码**。命中即标记账号、换号或退出等人工。
 */

/** URL 层面的信号 */
const URL_SIGNALS = [
  { type: 'robot_check', re: /\/errors\/validateCaptcha/i },
  { type: 'robot_check', re: /\/captcha\//i },
  { type: 'signin', re: /\/ap\/signin/i },
  { type: 'signin', re: /\/ap\/cvf\//i },
  { type: 'signin', re: /\/ap\/mfa/i },
];

/** DOM 层面的信号（在页面内求值） */
function domProbe() {
  const text = (document.body && document.body.innerText || '').slice(0, 4000);
  // 只认可见元素：Amazon 页面在 domcontentloaded 时的初始 HTML 里常带隐藏的登录表单/浮层，
  // 光看"元素存在"会把已登录页面误判成登录页（实测踩过：账号栏明明是 Hello, X）。
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  };
  const anyVisible = (sel) => Array.from(document.querySelectorAll(sel)).some(visible);

  return {
    url: location.href,
    title: document.title || '',
    hasCaptchaForm: anyVisible('form[action*="validateCaptcha"], form[action*="/errors/validateCaptcha"]'),
    hasCaptchaImg: anyVisible('img[src*="captcha"]'),
    hasSigninForm: anyVisible('#ap_email, #ap_password, form[name="signIn"]'),
    saysRobot: /Enter the characters you see below|Type the characters you see in this image|not a robot/i.test(text),
    saysDog: /Sorry! Something went wrong|Sorry, we just need to make sure you're not a robot/i.test(text),
    saysNotFound: /Looking for something\?|We're sorry\. The Web address you entered is not a functioning page/i.test(text),
    // 登录态：未登录时账号栏显示 "Hello, sign in"
    accountLine: (document.querySelector('#nav-link-accountList-nav-line-1')
      || document.querySelector('#nav-link-accountList'))?.innerText?.trim() || '',
  };
}

/** 账号栏文本是否表明"已登录" */
function accountLineSaysLoggedIn(line) {
  const s = String(line || '').trim().toLowerCase();
  if (!s) return false;
  return !/sign in|sign-in|登录|登入/.test(s);
}

/**
 * 检查当前页面。返回 null 表示正常；否则返回 { type, detail }。
 * type ∈ robot_check | signin | dog | not_found
 */
async function check(page) {
  const url = page.url();
  for (const sig of URL_SIGNALS) {
    if (sig.re.test(url)) return { type: sig.type, detail: `URL 命中：${url}` };
  }

  let probe;
  try {
    probe = await page.evaluate(domProbe);
  } catch (e) {
    return null;   // 页面正在导航等瞬态情况，交给上层重试
  }

  if (probe.hasCaptchaForm || probe.hasCaptchaImg || probe.saysRobot) {
    return { type: 'robot_check', detail: '页面出现人机验证' };
  }
  // signin 判定必须有权威信号：URL 命中（上面已查）或"可见登录表单 + 账号栏显示未登录"。
  // 单凭表单存在就判失效会误伤已登录页面，进而把好账号标成 signin_expired、拖垮整个池。
  if (probe.hasSigninForm && !accountLineSaysLoggedIn(probe.accountLine)) {
    return { type: 'signin', detail: '被重定向到登录页，登录态已失效' };
  }
  if (probe.saysDog) {
    return { type: 'dog', detail: 'Amazon 服务异常页（狗页）' };
  }
  if (probe.saysNotFound) {
    return { type: 'not_found', detail: '商品页不存在' };
  }
  return null;
}

/** 登录态判定：账号栏文本 + 鉴权 cookie 双重确认 */
async function isLoggedIn(context, page) {
  const probe = await page.evaluate(domProbe).catch(() => null);
  const domSaysLoggedIn = accountLineSaysLoggedIn(probe?.accountLine);

  const cookies = await context.cookies();
  const names = new Set(cookies.filter((c) => c.domain.includes('amazon.')).map((c) => c.name));
  const cookieSaysLoggedIn = names.has('x-main') && names.has('at-main');

  return { loggedIn: domSaysLoggedIn && cookieSaysLoggedIn, domSaysLoggedIn, cookieSaysLoggedIn, accountLine: probe?.accountLine || '' };
}

/**
 * 等页面渲染出登录态再做判定。
 * Amazon 在 domcontentloaded 时账号栏可能还没渲染，抢跑会读到初始 HTML 的隐藏登录表单。
 */
async function settleForAuth(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = await page.evaluate(
      () => (document.querySelector('#nav-link-accountList-nav-line-1')
        || document.querySelector('#nav-link-accountList'))?.innerText?.trim() || ''
    ).catch(() => '');
    if (line) return line;
    await new Promise((r) => setTimeout(r, 400));
  }
  return '';
}

module.exports = { check, isLoggedIn, domProbe, settleForAuth, accountLineSaysLoggedIn, URL_SIGNALS };
