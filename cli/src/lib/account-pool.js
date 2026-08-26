'use strict';
/**
 * 多账号池：选号 / 配额记账 / 健康状态机 / 冷却。
 *
 * 轮换策略 = 配额+健康度驱动（sticky）：
 *   一个账号一直跑，直到撞日配额或被判异常才换下一个；切换只发生在 ASIN 边界。
 * 这样切换成本最低，账号行为也最接近真人。
 *
 * 绝不并行使用多账号 —— 同机并发是最强的账号关联信号。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = path.join(os.homedir(), '.apinsight');
const ACCOUNTS_PATH = path.join(HOME_DIR, 'accounts.json');
const STATE_PATH = path.join(HOME_DIR, 'account-state.json');
const PROFILES_DIR = path.join(HOME_DIR, 'profiles');

const STATUS = {
  ACTIVE: 'active',
  COOLING: 'cooling',
  CAPTCHA_BLOCKED: 'captcha_blocked',
  SIGNIN_EXPIRED: 'signin_expired',
  DISABLED: 'disabled',
};

/** 池耗尽的原因 → 进程退出码（README 与 cron 告警依赖这个映射） */
const EXIT_CODE = {
  CAPTCHA: 3,
  SIGNIN: 4,
  QUOTA: 5,
};

const DEFAULTS = {
  maxPerDay: 600,
  cooldownMinutes: 30,
  errorsBeforeCooling: 3,
};

class PoolExhaustedError extends Error {
  constructor(reason, exitCode, detail) {
    super(detail);
    this.name = 'PoolExhaustedError';
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

function localDate(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

class AccountPool {
  constructor({ accounts, state, statePath = STATE_PATH, now = () => Date.now() }) {
    this.accounts = accounts;
    this.state = state || {};
    this.statePath = statePath;
    this.now = now;
    this.currentId = null;
    for (const a of this.accounts) this._ensureState(a.id);
  }

  static load({ accountsPath = ACCOUNTS_PATH, statePath = STATE_PATH, now = () => Date.now(), only = null } = {}) {
    if (!fs.existsSync(accountsPath)) {
      throw new Error(
        `账号池未配置：${accountsPath}\n先跑 \`apinsight accounts import --id <id> --file <cookie导出>\` 建立账号。`
      );
    }
    const cfg = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    let accounts = (cfg.accounts || []).map((a) => ({
      maxPerDay: DEFAULTS.maxPerDay,
      marketplace: 'US',
      enabled: true,
      proxy: null,
      ...a,
    }));
    if (only && only.length) {
      const want = new Set(only);
      accounts = accounts.filter((a) => want.has(a.id));
      const missing = only.filter((id) => !accounts.some((a) => a.id === id));
      if (missing.length) throw new Error(`--accounts 指定了不存在的账号：${missing.join(', ')}`);
    }
    if (!accounts.length) throw new Error('账号池为空');
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
    return new AccountPool({ accounts, state, statePath, now });
  }

  static profileDir(id) {
    return path.join(PROFILES_DIR, id);
  }

  _ensureState(id) {
    if (!this.state[id]) {
      this.state[id] = {
        status: STATUS.ACTIVE,
        date: localDate(this.now()),
        questionsAsked: 0,
        lastUsedAt: null,
        cooldownUntil: null,
        consecutiveErrors: 0,
        lastIncident: null,
      };
    }
    return this.state[id];
  }

  /** 跨自然日重置配额；冷却到期自动回 active */
  _refresh(id) {
    const st = this._ensureState(id);
    const today = localDate(this.now());
    if (st.date !== today) {
      st.date = today;
      st.questionsAsked = 0;
    }
    if (st.status === STATUS.COOLING && st.cooldownUntil && this.now() >= st.cooldownUntil) {
      st.status = STATUS.ACTIVE;
      st.cooldownUntil = null;
      st.consecutiveErrors = 0;
    }
    return st;
  }

  stateOf(id) {
    return this._refresh(id);
  }

  remainingQuota(acct) {
    const st = this._refresh(acct.id);
    return Math.max(0, acct.maxPerDay - st.questionsAsked);
  }

  isUsable(acct) {
    if (!acct.enabled) return false;
    const st = this._refresh(acct.id);
    return st.status === STATUS.ACTIVE && this.remainingQuota(acct) > 0;
  }

  /**
   * 选号。sticky：当前账号还能用就继续用，避免无谓切换。
   * 选不出来时抛 PoolExhaustedError，带上区分原因的退出码。
   */
  acquire({ need = 1 } = {}) {
    // need = 这个 ASIN 还要问多少题。
    // 必须纳入选号：若账号剩余配额不够跑完整个 ASIN，答到一半撞配额后
    // 「同 ASIN 不跨账号」会把已答的行整体作废 —— 那些题的真实请求就白烧了。
    const enough = (a) => this.remainingQuota(a) >= need;

    const current = this.accounts.find((a) => a.id === this.currentId);
    if (current && this.isUsable(current) && enough(current)) return current;

    const usable = this.accounts.filter((a) => this.isUsable(a));
    const candidates = usable
      .filter(enough)
      .sort((a, b) => {
        const q = this.remainingQuota(b) - this.remainingQuota(a);
        if (q !== 0) return q;
        return (this._refresh(a.id).lastUsedAt || 0) - (this._refresh(b.id).lastUsedAt || 0);
      });

    // 有账号能用但都不够跑完整个 ASIN：不要开工，否则做的功会被作废
    if (!candidates.length && usable.length) {
      const best = Math.max(...usable.map((a) => this.remainingQuota(a)));
      throw new PoolExhaustedError('quota', EXIT_CODE.QUOTA,
        `剩余配额不足以完整跑完一个 ASIN（需 ${need} 题，最多的账号只剩 ${best} 题）。`
        + '不开工以免做的功被作废。可等次日配额重置、加账号，或用 --allow-mixed-account 允许同 ASIN 跨账号。');
    }

    if (candidates.length) {
      this.currentId = candidates[0].id;
      const st = this._refresh(this.currentId);
      st.lastUsedAt = this.now();
      this.save();
      return candidates[0];
    }

    throw this._exhausted();
  }

  _exhausted() {
    const byStatus = (s) => this.accounts.filter((a) => this._refresh(a.id).status === s).map((a) => a.id);
    const captcha = byStatus(STATUS.CAPTCHA_BLOCKED);
    const signin = byStatus(STATUS.SIGNIN_EXPIRED);

    if (captcha.length) {
      return new PoolExhaustedError('captcha', EXIT_CODE.CAPTCHA,
        `以下账号撞到人机验证，需人工处理后 \`apinsight accounts enable <id>\`：${captcha.join(', ')}`);
    }
    if (signin.length) {
      return new PoolExhaustedError('signin', EXIT_CODE.SIGNIN,
        `以下账号登录态失效，需重新导入 cookie 或 \`apinsight login --account <id>\`：${signin.join(', ')}`);
    }

    const next = this.accounts
      .map((a) => this._refresh(a.id).cooldownUntil)
      .filter(Boolean)
      .sort((a, b) => a - b)[0];
    const hint = next ? `最早可用时间：${new Date(next).toLocaleString()}` : '明日自然日配额重置后可继续';
    return new PoolExhaustedError('quota', EXIT_CODE.QUOTA, `全部账号今日配额已用尽或处于冷却。${hint}`);
  }

  /** guard 命中异常时标记账号 */
  mark(acct, incidentType) {
    const st = this._refresh(acct.id);
    const map = {
      robot_check: STATUS.CAPTCHA_BLOCKED,
      captcha: STATUS.CAPTCHA_BLOCKED,
      signin: STATUS.SIGNIN_EXPIRED,
      signin_expired: STATUS.SIGNIN_EXPIRED,
      alexa_auth_required: STATUS.SIGNIN_EXPIRED,   // 需人工在本机真实登录一次
    };
    st.status = map[incidentType] || STATUS.COOLING;
    st.lastIncident = { type: incidentType, at: this.now() };
    if (st.status === STATUS.COOLING) {
      st.cooldownUntil = this.now() + DEFAULTS.cooldownMinutes * 60_000;
    }
    if (this.currentId === acct.id) this.currentId = null;
    this.save();
    return st;
  }

  /** 每问完一题记账；连续错误累计到阈值转入冷却 */
  recordQuestion(acct, status) {
    const st = this._refresh(acct.id);
    st.questionsAsked += 1;
    st.lastUsedAt = this.now();
    if (status === 'error') {
      st.consecutiveErrors += 1;
      if (st.consecutiveErrors >= DEFAULTS.errorsBeforeCooling) {
        st.status = STATUS.COOLING;
        st.cooldownUntil = this.now() + DEFAULTS.cooldownMinutes * 60_000;
        st.lastIncident = { type: 'consecutive_errors', at: this.now() };
        if (this.currentId === acct.id) this.currentId = null;
      }
    } else {
      st.consecutiveErrors = 0;
    }
    this.save();
    return st;
  }

  /** 该账号是否该让位（撞配额或已转冷却/异常）→ 调用方跳出题目循环，下个 ASIN 换号 */
  shouldYield(acct) {
    return !this.isUsable(acct);
  }

  setEnabled(id, enabled) {
    const acct = this.accounts.find((a) => a.id === id);
    if (!acct) throw new Error(`未知账号：${id}`);
    acct.enabled = enabled;
    if (enabled) {
      const st = this._refresh(id);
      st.status = STATUS.ACTIVE;
      st.cooldownUntil = null;
      st.consecutiveErrors = 0;
    }
    this.save();
    return acct;
  }

  resetQuota(id) {
    const st = this._ensureState(id);
    st.questionsAsked = 0;
    st.date = localDate(this.now());
    this.save();
    return st;
  }

  summary() {
    return this.accounts.map((a) => {
      const st = this._refresh(a.id);
      return {
        id: a.id,
        marketplace: a.marketplace,
        enabled: a.enabled,
        status: st.status,
        used: st.questionsAsked,
        maxPerDay: a.maxPerDay,
        remaining: this.remainingQuota(a),
        cooldownUntil: st.cooldownUntil,
        lastIncident: st.lastIncident,
        hasProxy: Boolean(a.proxy),
      };
    });
  }

  save() {
    atomicWriteJson(this.statePath, this.state);
  }
}

module.exports = {
  AccountPool,
  PoolExhaustedError,
  STATUS,
  EXIT_CODE,
  DEFAULTS,
  ACCOUNTS_PATH,
  STATE_PATH,
  PROFILES_DIR,
  HOME_DIR,
  localDate,
  atomicWriteJson,
};
