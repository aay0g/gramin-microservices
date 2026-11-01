import { HttpError } from './errors.js';

export async function sendTemplate(config, org, message, fetchImpl = fetch) {
  const template = org.templates[message.template];
  const parameters = template.bodyParameters.map(name => ({ type: 'text', text: message.parameters[name] }));
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: message.to,
    type: 'template', template: {
      name: template.name, language: { code: template.language },
      ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {})
    }
  };
  let response;
  let result;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${org.phoneNumberId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${org.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000), redirect: 'error'
    });
    result = await response.json();
  } catch {
    // A timeout can occur after Meta accepted the message. Never retry automatically.
    throw new HttpError(502, 'META_OUTCOME_UNKNOWN', 'Meta response unavailable; delivery outcome is unknown. Do not blindly retry.');
  }
  if (!response.ok) throw new HttpError(502, 'META_REJECTED', 'Meta rejected the message. Check sender, approved template, recipient, and account configuration.');
  const messageId = result?.messages?.[0]?.id;
  if (typeof messageId !== 'string' || !messageId) throw new HttpError(502, 'META_OUTCOME_UNKNOWN', 'Meta did not return a message ID; do not blindly retry.');
  return { messageId, status: 'accepted' };
}
