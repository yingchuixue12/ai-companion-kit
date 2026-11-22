/**
 * 媒体能力探测（D0 / T7）
 * ─────────────────────────────────────────────────────────────
 * 只检查注入的适配器是否存在对应方法，并读取适配器自述；
 * 不实例化供应商、不发网络、不探测设备。
 *
 * 图片/文件在 D0 永远返回 provider-required：没有 U2 之前不假装能理解内容。
 */

import { MEDIA_CONTRACT_VERSION } from './contracts.js';

function describeAdapter(adapter, capability, method) {
  if (!adapter || typeof adapter[method] !== 'function') {
    return Object.freeze({
      available: false,
      capability,
      adapter: null,
      offline: false,
      reason: 'provider-required',
    });
  }
  let described = null;
  try {
    described = typeof adapter.describe === 'function' ? adapter.describe() : null;
  } catch {
    described = null;
  }
  const provider = typeof described?.provider === 'string' && described.provider.trim()
    ? described.provider.trim()
    : (typeof adapter.provider === 'string' && adapter.provider.trim() ? adapter.provider.trim() : 'injected');
  const offline = described?.offline === true || adapter.offline === true;
  return Object.freeze({
    available: true,
    capability,
    adapter: provider,
    offline,
    reason: offline ? 'offline-stub' : 'adapter-injected',
  });
}

/**
 * @param {{asr?:object, tts?:object, now?:() => number}} input
 */
export function probeMediaCapabilities({ asr = null, tts = null, now = null } = {}) {
  const report = {
    version: MEDIA_CONTRACT_VERSION,
    asr: describeAdapter(asr, 'audio-input', 'transcribe'),
    tts: describeAdapter(tts, 'audio-output', 'synthesize'),
    image: Object.freeze({
      available: false,
      capability: 'image-input',
      adapter: null,
      offline: false,
      reason: 'provider-required',
      requiresUserDecision: 'U2',
    }),
    file: Object.freeze({
      available: false,
      capability: 'file-input',
      adapter: null,
      offline: false,
      reason: 'provider-required',
      requiresUserDecision: 'U2',
    }),
  };
  if (typeof now === 'function') report.checkedAt = now();
  return Object.freeze(report);
}
