// ModelScope's container entry point. Local npm start keeps its existing behavior.
const password = process.env.BOOTSTRAP_PASSWORD;
if (!password || password.length < 12 || password.length > 256) {
  throw new Error('Set BOOTSTRAP_PASSWORD in Studio Secrets to a unique password of 12–256 characters.');
}

let publicOrigin;
try { publicOrigin = new URL(process.env.PUBLIC_ORIGIN); } catch { /* Validated below. */ }
if (!publicOrigin || publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password ||
    publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) {
  throw new Error('Set PUBLIC_ORIGIN to the application HTTPS origin, without a path, query or credentials.');
}

process.env.PUBLIC_ORIGIN = publicOrigin.origin;
process.env.HOST = '0.0.0.0';
process.env.PORT = '7860';
process.env.COOKIE_SECURE = '1';
process.env.TRUST_PROXY = '1';
process.env.MODELSCOPE_EMBED = '1';
process.env.DATA_DIR ||= '/mnt/workspace/landlord';
await import('./start.mjs');
