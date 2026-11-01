import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';
import { sendTemplate } from './meta.js';

function equal(a, b) {
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new HttpError(413, 'BODY_TOO_LARGE', 'Body limit is 64 KiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parse(raw) {
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'Invalid JSON body'); }
}
function validate(message, org) {
  const fail = text => { throw new HttpError(400, 'INVALID_MESSAGE', text); };
  if (!message || typeof message !== 'object' || Array.isArray(message)) fail('Expected an object');
  if (Object.keys(message).some(k => !['to', 'template', 'parameters', 'recipientOptIn'].includes(k))) fail('Unknown message field');
  if (typeof message.to !== 'string' || !/^[1-9]\d{7,14}$/.test(message.to)) fail('to must contain 8–15 international phone digits, without +');
  if (message.recipientOptIn !== true) fail('recipientOptIn must be true; caller must verify recipient consent');
  if (typeof message.template !== 'string' || !Object.hasOwn(org.templates, message.template)) fail('Template is not configured for this organization');
  const expected = org.templates[message.template].bodyParameters;
  const params = message.parameters;
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== expected.length
    || expected.some(k => !Object.hasOwn(params, k) || typeof params[k] !== 'string' || !params[k].trim() || params[k].length > 1024)) fail('parameters must match configured template fields, with nonempty text values up to 1024 characters');
}

export function createApp(config, { fetchImpl = fetch, log = event => console.log(JSON.stringify(event)) } = {}) {
  return async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' });
      if (url.pathname === '/webhooks/whatsapp' && req.method === 'GET') {
        const token = url.searchParams.get('hub.verify_token') || '';
        const challenge = url.searchParams.get('hub.challenge');
        if (url.searchParams.get('hub.mode') !== 'subscribe' || !equal(token, config.verifyToken) || !challenge) throw new HttpError(403, 'VERIFICATION_FAILED', 'Webhook verification failed');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end(challenge);
      }
      if (url.pathname === '/webhooks/whatsapp' && req.method === 'POST') {
        const raw = await body(req);
        const signature = req.headers['x-hub-signature-256'];
        const expected = `sha256=${createHmac('sha256', config.appSecret).update(raw).digest('hex')}`;
        if (typeof signature !== 'string' || !equal(signature, expected)) throw new HttpError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
        const event = parse(raw);
        if (event?.object !== 'whatsapp_business_account' || !Array.isArray(event.entry)) throw new HttpError(400, 'INVALID_WEBHOOK', 'Expected a WhatsApp Business Account event');
        // Initial milestone: status logs only. No inbound message storage or business actions.
        for (const entry of event.entry) {
          for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
            const value = change?.value;
            for (const status of Array.isArray(value?.statuses) ? value.statuses : []) {
              if (typeof status?.id === 'string' && ['sent', 'delivered', 'read', 'failed'].includes(status.status)) {
                log({ severity: 'INFO', event: 'whatsapp_status', requestId, messageId: status.id,
                  status: status.status, phoneNumberId: value.metadata?.phone_number_id,
                  errorCodes: Array.isArray(status.errors) ? status.errors.map(e => e.code).filter(Number.isInteger) : [] });
              }
            }
          }
        }
        return json(res, 200, { received: true });
      }
      const match = /^\/v1\/organizations\/([a-z0-9_-]+)\/messages\/template$/.exec(url.pathname);
      if (req.method === 'POST' && match) {
        const org = config.organizations.get(match[1]);
        const auth = req.headers.authorization || '';
        if (!org || !equal(auth, `Bearer ${org.apiKey}`)) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid organization credentials');
        const message = parse(await body(req));
        validate(message, org);
        const result = await sendTemplate(config, org, message, fetchImpl);
        log({ severity: 'INFO', event: 'message_accepted', requestId, organizationId: match[1], messageId: result.messageId });
        return json(res, 202, { ...result, requestId });
      }
      throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      log({ severity: status >= 500 ? 'ERROR' : 'WARNING', event: 'request_failed', requestId, code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' });
      if (!res.destroyed) json(res, status, { error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR', message: status === 500 ? 'Internal server error' : error.message }, requestId });
    }
  };
}
