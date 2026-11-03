import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, createApp(config));
server.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ severity: 'INFO', event: 'service_started', port: config.port, mode: config.mode }));
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
