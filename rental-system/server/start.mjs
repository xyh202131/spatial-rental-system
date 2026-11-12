import { createApp } from './app.mjs';
import { join } from 'node:path';

const port = Number(process.env.PORT || 4327);
const root = join(import.meta.dirname, '..');
const furnitureDir = join(root, 'materials', 'furniture');
const { server, store } = createApp({
  dataDir: process.env.DATA_DIR || join(root, '.data'),
  furnitureDir, arDir: furnitureDir, portalHome: true,
  port,
  username: process.env.BOOTSTRAP_USERNAME,
  password: process.env.BOOTSTRAP_PASSWORD,
});
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`空间智能租房系统已启动：http://127.0.0.1:${port}/cover/`);
  if (store.credentialFile) console.log(`本机登录信息：${store.credentialFile}`);
});
function shutdown() {
  server.close(() => { store.db.close(); process.exit(0); });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
