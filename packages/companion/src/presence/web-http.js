import { PRESENCE_WEB_SIGNAL_FLAGS } from './web-host.js';

const SIGNAL_PATH = '/presence/signal';
const MESSAGES_PATH = '/presence/messages';
const MAX_BODY_BYTES = 256;

function reply(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readSignal(req) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return { status: 415, error: 'json-required' };
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    return { status: 413, error: 'body-too-large' };
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) return { status: 413, error: 'body-too-large' };
    chunks.push(buffer);
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return { status: 400, error: 'invalid-json' };
  }
  const kind = data?.kind;
  const flag = typeof kind === 'string' && Object.hasOwn(PRESENCE_WEB_SIGNAL_FLAGS, kind)
    ? PRESENCE_WEB_SIGNAL_FLAGS[kind]
    : undefined;
  if (!flag || typeof data[flag] !== 'boolean' || Object.keys(data).length !== 2
    || !Object.hasOwn(data, flag)) {
    return { status: 400, error: 'invalid-signal' };
  }
  return { signal: { kind, [flag]: data[flag] } };
}

/**
 * Mount on a trusted loopback server. The caller owns authentication, origin
 * checks, timeouts, settlement ticks and host lifecycle. No routes opt in
 * unless authorize(req) explicitly returns true. Unhandled routes return false.
 */
export function createPresenceHttpHandler({ host, authorize } = {}) {
  return async function handlePresenceRequest(req, res) {
    const [pathname, query = ''] = (req.url ?? '').split(/\?(.*)/s, 2);
    if (pathname !== SIGNAL_PATH && pathname !== MESSAGES_PATH) return false;
    const send = (status, body) => {
      req.resume();
      reply(res, status, body);
      return true;
    };
    try {
      let allowed = false;
      try {
        allowed = typeof authorize === 'function' && await authorize(req) === true;
      } catch {
        // Authentication exceptions never become response text.
      }
      if (!allowed) return send(403, { error: 'forbidden' });
      if (!host) return send(503, { error: 'presence-unavailable' });

      if (pathname === MESSAGES_PATH) {
        if (req.method !== 'GET') return send(405, { error: 'method-not-allowed' });
        const params = new URLSearchParams(query);
        const after = params.get('after');
        if (params.size > (after === null ? 0 : 1) || (after?.length ?? 0) > 128) {
          return send(400, { error: 'invalid-cursor' });
        }
        const { cursor, messages } = host.messages(after);
        return send(200, { cursor, messages });
      }

      if (req.method !== 'POST') return send(405, { error: 'method-not-allowed' });
      if (query) return send(400, { error: 'unexpected-query' });
      const { signal, error, status } = await readSignal(req);
      if (!signal) return send(status, { error });
      const result = host.observe(signal);
      return send(result.ok ? 200 : 409, { ok: result.ok, status: result.status });
    } catch {
      if (!res.destroyed && !res.headersSent) return send(500, { error: 'presence-error' });
      return true;
    }
  };
}
