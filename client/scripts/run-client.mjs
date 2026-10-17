import { preview } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
process.env.TREK_DEV_API ??= 'http://127.0.0.1:3000';
const server = await preview({ root: path.join(root, 'client'), configFile: path.join(root, 'client/vite.config.js'),
  preview: { host: '127.0.0.1', port: 5173, strictPort: true } });
server.printUrls();
