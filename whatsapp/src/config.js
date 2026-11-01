import { readFileSync } from 'node:fs';

export function loadConfig(env = process.env) {
  const required = (name) => {
    if (!env[name] || env[name].startsWith('replace-with')) throw new Error(`Configure ${name}`);
    return env[name];
  };
  const graphVersion = required('META_GRAPH_VERSION');
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error('META_GRAPH_VERSION must be a supported version, e.g. vNN.0');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  // Inline JSON is suitable for a Secret Manager environment injection on Cloud Run.
  const raw = env.ORGANIZATIONS_JSON || readFileSync(required('ORGANIZATIONS_FILE'), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Organizations must be an object');
  const organizations = new Map();
  const keys = new Set();
  for (const [id, org] of Object.entries(parsed)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !org || !/^\d+$/.test(org.phoneNumberId)) throw new Error(`Invalid organization configuration: ${id}`);
    const apiKey = required(org.apiKeyEnv);
    if (apiKey.length < 32 || keys.has(apiKey)) throw new Error('Organization API keys must be unique and at least 32 characters');
    keys.add(apiKey);
    if (!org.templates || typeof org.templates !== 'object' || Array.isArray(org.templates) || !Object.keys(org.templates).length) throw new Error(`Configure templates for ${id}`);
    for (const template of Object.values(org.templates)) {
      if (!template || !/^[a-z0-9_]+$/.test(template.name) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(template.language)
        || !Array.isArray(template.bodyParameters) || template.bodyParameters.some(p => typeof p !== 'string' || !p)
        || new Set(template.bodyParameters).size !== template.bodyParameters.length) throw new Error(`Invalid template for ${id}`);
    }
    organizations.set(id, { ...org, apiKey, accessToken: required(org.accessTokenEnv) });
  }
  if (!organizations.size) throw new Error('Configure at least one organization');
  return { port, graphVersion, appSecret: required('META_APP_SECRET'), verifyToken: required('META_WEBHOOK_VERIFY_TOKEN'), organizations };
}
