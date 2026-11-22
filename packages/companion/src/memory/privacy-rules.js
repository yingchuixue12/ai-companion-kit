/**
 * 记忆写入侧的隐私规则（M-7 / P-7）
 * ─────────────────────────────────────────────────────────────
 * 这里只做**最小、高精度**的模式识别，供 `memory.js` 在真正写盘之前使用：
 *
 *   1. `SECRET_RULES`：疑似密钥 / 令牌 / 凭证 / 完整账号。命中即**拒绝落盘**，
 *      正文一个字符都不进 `people.json` / `records.jsonl` / `turns.jsonl`。
 *   2. `IMPERATIVE_RULES`：把「你以后必须……」「忽略以上规则」这类**指令型文本**
 *      写进长期记忆（P-7 的注入面）。命中即拒绝或隔离，不让它进 prompt。
 *
 * 设计取舍（为什么是这些模式，而不是更多）：
 *   - 每条规则都必须有明确理由（`why`），否则宁可先不加。
 *   - **不做**「含『你』就拒」这种机械规则：普通事实大量以「你」开头
 *     （「你说过你喜欢猫」「你昨天推荐的店很好吃」），机械拒绝会把正常记忆删空。
 *   - **不做**「任意 10~11 位数字就是 QQ 号」：订单号、时间戳、价格都会误伤；
 *     只有带明确标签（QQ/微信/手机号/邮箱…）的账号才按秘密处理。
 *   - 长十六进制串（32 位以上）按令牌处理：正常聊天里出现 32 位以上 hex，
 *     绝大多数是 key / 签名 / 哈希，漏存一条事实的代价远低于把凭证写进 prompt。
 *   - 规则只作用于**写入的记忆文本**，不扫描日志、不联网、不读环境变量。
 *
 * 这些规则是「越严越好」的方向：只会让更少的内容落盘，不会放宽任何现有过滤。
 */

export const PRIVACY_RULES_VERSION = 1;

/** 命中秘密时写进文本的占位符（固定常量，绝不包含原文） */
export const REDACTION_MARKER = '[已隐藏]';

/**
 * 秘密模式。`pattern` 不允许带 `g`（避免 test 的 lastIndex 状态污染）。
 * `why` 是给审计和误伤回归看的理由，不进 prompt。
 */
export const SECRET_RULES = Object.freeze([
  Object.freeze({
    id: 'api-key',
    why: 'sk-/pk-/rk- 前缀加长串几乎只出现在 API key 里；存进长期记忆等于把凭证抄进每轮 prompt。',
    pattern: /\b(?:sk|pk|rk)[-_][A-Za-z0-9]{16,}\b/,
  }),
  Object.freeze({
    id: 'bearer-token',
    why: 'HTTP Authorization 的 Bearer 值是可重放的凭证。',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  }),
  Object.freeze({
    id: 'jwt',
    why: 'JWT 三段式自带签名，泄露即可冒充身份。',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  }),
  Object.freeze({
    id: 'private-key-block',
    why: '私钥 PEM 头一旦落盘就是长期风险；规则必须覆盖**整个块**（含 base64 正文），只匹配 BEGIN 头会把密钥正文留在文本里。',
    // 整块匹配：从 BEGIN 到 END；缺 END（被截断/粘贴不全）时一直清到文本末尾。
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/,
  }),
  Object.freeze({
    id: 'credential-url',
    why: 'user:password@host 形式的 URL 把账号密码一起暴露；必须连路径/查询参数一起清掉，否则残留的 token 仍是凭证。',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@\S*/i,
  }),
  Object.freeze({
    id: 'password-assignment',
    why: '「密码/口令是 X」是显式凭证陈述，落盘没有收益。',
    pattern: /(?:密码|口令|pass(?:word|wd)?|pwd)\s*(?:是|为|[:：=])\s*\S{4,}/i,
  }),
  Object.freeze({
    id: 'verification-code',
    why: '短信/邮件验证码有有效期，但落盘后仍可被日志与备份带出。',
    pattern: /(?:验证码|校验码|动态码|verification code|otp)\s*(?:是|为|[:：=])?\s*\d{4,8}\b/i,
  }),
  Object.freeze({
    id: 'labeled-account',
    why: '带标签的完整账号（QQ/微信/手机号/邮箱）属于可定位的个人标识；值必须像账号（含数字或邮箱），「手机是 iPhone」这类不算。',
    pattern: /(?:qq|微信|账号|帐号|手机号|手机|电话|邮箱)\s*(?:号|号码)?\s*(?:是|为|[:：=])\s*(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?=[A-Za-z0-9_@.-]*\d)[A-Za-z0-9_@.-]{4,})/i,
  }),
  Object.freeze({
    id: 'id-card',
    why: '18 位身份证号是强标识，且误伤概率极低。',
    pattern: /\b\d{17}[\dXx]\b/,
  }),
  Object.freeze({
    id: 'long-hex-token',
    why: '32 位以上十六进制串通常就是 key/签名/哈希；聊天里几乎没有别的用途。',
    pattern: /\b[0-9a-f]{32,}\b/i,
  }),
]);

/**
 * 祈使/注入模式。只匹配**明确的指令句**（句首祈使、覆盖规则、角色劫持），
 * 不匹配普通陈述，避免把「医生说你要早点睡」这类事实误判成注入。
 */
export const IMPERATIVE_RULES = Object.freeze([
  Object.freeze({
    id: 'imperative-directive',
    why: '句首「你以后必须/不准…」是在给角色立规矩，属于 L1 覆盖尝试（P-7）。',
    pattern: /^(?:你|妳)\s*(?:(?:以后|今后|从现在起|从今以后|从今天起|之后)\s*(?:必须|要|不准|不许|禁止|只能|得|别再|不要再)|(?:必须|一定要|不准|不许|禁止|只能|别再|不要再))/,
  }),
  Object.freeze({
    id: 'role-override',
    why: '「忽略以上规则/提示词」是直接攻击，落进记忆会反复注入。',
    pattern: /(?:忽略|无视|忘记|绕过|跳过)(?:掉)?(?:(?:以上|之前|上面|前面|所有|全部|的)\s*)*(?:规则|指令|设定|提示词|限制|人设)/,
  }),
  Object.freeze({
    id: 'persona-override',
    why: '「从现在起你是…」「你扮演…」是角色劫持，必须挡在长期记忆之外；问句（扮演过吗/扮演什么）不算。',
    pattern: /(?:(?:从现在起|从今天起|从今以后)\s*(?:你|妳)\s*(?:是|就是|扮演|假装)|^(?:你|妳)\s*(?:扮演|假装)(?!过|吗|么|什么|谁|哪))/,
  }),
  Object.freeze({
    id: 'rule-prefix',
    why: '「记住：你必须…」把指令伪装成记忆条目。',
    pattern: /^(?:记住|牢记|请记住|你要记住)[：:,，\s]\s*(?:你|妳)\s*(?:必须|只能|永远|绝对|不准|不许|禁止)/,
  }),
]);

function scanRules(rules, text) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return [];
  const hits = [];
  for (const rule of rules) {
    // 规则不允许 g；这里仍显式复位，防止调用方改了规则对象。
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(source)) hits.push({ id: rule.id, why: rule.why });
  }
  return hits;
}

/** 扫描疑似秘密；返回 `[{id, why}]`，空数组表示未命中。 */
export function scanSecrets(text) {
  return scanRules(SECRET_RULES, text);
}

/** 扫描祈使/注入；返回 `[{id, why}]`，空数组表示未命中。 */
export function scanImperative(text) {
  return scanRules(IMPERATIVE_RULES, text);
}

/** 是否含疑似秘密（布尔快捷方式）。 */
export function hasSecretPattern(text) {
  return scanSecrets(text).length > 0;
}

/**
 * 把文本里的秘密替换成 `REDACTION_MARKER`。
 * 返回 `{ text, rules }`；`rules` 只含规则 id，不含原文。
 */
export function redactSecrets(text) {
  let out = String(text ?? '');
  const rules = new Set();
  for (const rule of SECRET_RULES) {
    if (!rule.pattern.test(out)) continue;
    rules.add(rule.id);
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    out = out.replace(new RegExp(rule.pattern.source, flags), REDACTION_MARKER);
  }
  return { text: out, rules: [...rules] };
}

/**
 * 记忆写入的统一裁决：
 *   - `reject`：疑似秘密 → 不落盘（调用方必须丢弃正文）；
 *   - `quarantine`：祈使/注入 → 可隔离（v2 有状态位；v1 无状态位时按 reject 处理）；
 *   - `accept`：正常内容。
 * 来源豁免由调用方处理：`host_verified` 只豁免 `quarantine`（P-9），
 * 永远不豁免 `reject`（秘密不因来源变成可存）。
 */
export function classifyMemoryWrite(text) {
  const secrets = scanSecrets(text);
  if (secrets.length) return { action: 'reject', rules: secrets.map((hit) => hit.id) };
  const imperative = scanImperative(text);
  if (imperative.length) return { action: 'quarantine', rules: imperative.map((hit) => hit.id) };
  return { action: 'accept', rules: [] };
}
