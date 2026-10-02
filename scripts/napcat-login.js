import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

// API fields verified against the installed v4.18.28 release implementation.
const webui = JSON.parse(readFileSync('runtime/napcat/config/webui.json', 'utf8'));
const base = `http://127.0.0.1:${webui.port || 6099}/api`;
async function post(path, body, credential) {
  const response = await fetch(base + path, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('WEBUI_HTTP_FAILED');
  return response.json();
}
try {
  const login = await post('/auth/login', { hash: createHash('sha256').update(webui.token + '.napcat').digest('hex') });
  const credential = login.data?.Credential;
  if (!credential) throw new Error('WEBUI_AUTH_FAILED');
  if (process.argv.includes('--refresh')) {
    const result = await post('/QQLogin/RefreshQRcode', {}, credential);
    console.log(JSON.stringify({ refreshed: Boolean(result.data?.qrcodeurl),
      restarting: Boolean(result.data?.restarting) }));
    if (!result.data?.qrcodeurl) process.exitCode = 1;
  } else {
    const result = await post('/QQLogin/CheckLoginStatus', {}, credential);
    // Only public status fields, never QR URLs, hashes or credentials.
    const data = result.data || {};
    console.log(JSON.stringify({ statusFields: Object.keys(data),
      isLogin: data.isLogin ?? data.isLoggedIn ?? data.isLogined ?? null,
      loginPhase: data.loginPhase ?? data.phase ?? null }));
  }
  console.log(JSON.stringify({ qrFile: 'runtime/napcat/cache/qrcode.png',
    modified: statSync('runtime/napcat/cache/qrcode.png').mtime.toISOString() }));
} catch {
  console.error('NAPCAT_LOGIN_API_FAILED'); process.exitCode = 1;
}
