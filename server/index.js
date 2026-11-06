import { createBridge } from './bridge.js';

const host = process.env.BRIDGE_LISTEN_HOST || '127.0.0.1';
const port = Number(process.env.BRIDGE_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BRIDGE_PORT');

createBridge().listen(port, host, () => {
  console.log('PhiMail experimental bridge listening on ' + host + ':' + port);
  console.log('Use the same-origin Vite proxy or a HTTPS reverse proxy. Do not expose this experimental service directly.');
});
