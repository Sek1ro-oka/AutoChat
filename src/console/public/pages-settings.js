/* 设置：把 /api/settings 的字段表按分组画成表单。
 * 写路由是 POST /api/settings { name, value }；空字符串表示清除覆盖、回到 .env 默认值。
 * 字段表本身来自 src/runtime-config.js，所以这里不写死任何键名或取值范围。
 */

const settingsState = { notice: '', bad: false };

const settingSay = (text, bad = false) => {
  settingsState.notice = String(text || '');
  settingsState.bad = Boolean(bad);
};

const settingNotice = () => (settingsState.notice
  ? alertBox(settingsState.bad ? 'err' : 'ok', settingsState.bad ? '没保存' : '已保存', settingsState.notice)
  : '');

const SETTING_CONTROL = {
  boolean: field => sw(field.value === 'true', '', `data-act="settingToggle" data-name="${esc(field.name)}"`),
  enum: field => `<select id="cfg-${esc(field.name)}">${(field.options || [])
    .map(option => `<option value="${esc(option)}"${String(option) === String(field.value) ? ' selected' : ''}>${esc(option)}</option>`)
    .join('')}</select>`,
  number: field => `<input id="cfg-${esc(field.name)}" type="number" step="any" value="${esc(field.value)}"${field.min === undefined ? '' : ` min="${esc(field.min)}"`}${field.max === undefined ? '' : ` max="${esc(field.max)}"`}>`,
  integer: field => `<input id="cfg-${esc(field.name)}" type="number" step="1" value="${esc(field.value)}"${field.min === undefined ? '' : ` min="${esc(field.min)}"`}${field.max === undefined ? '' : ` max="${esc(field.max)}"`}>`,
};

const settingControl = (field) => {
  const build = SETTING_CONTROL[field.kind] || (item =>
    `<input id="cfg-${esc(item.name)}" type="text" value="${esc(item.value)}"${item.max === undefined ? '' : ` maxlength="${esc(item.max)}"`}>`);
  return build(field);
};

const settingRow = (field) => {
  const overridden = String(field.value) !== String(field.defaultValue);
  const control = settingControl(field);
  const buttons = field.kind === 'boolean'
    ? ''
    : `<div class="row">
        <button type="button" class="btn btn-primary" data-act="settingSave" data-name="${esc(field.name)}">保存</button>
        <button type="button" class="btn" data-act="settingReset" data-name="${esc(field.name)}">恢复默认</button>
      </div>`;
  return `<div class="field" data-setting="${esc(field.name)}">
    <span class="flabel">
      <span class="lname">${esc(field.label)}${overridden ? badge('已覆盖', 'warn') : ''}</span>
      <span class="lkey mono">${esc(field.key)}${overridden ? ` · 默认 ${esc(field.defaultValue === '' ? '空' : field.defaultValue)}` : ''}</span>
    </span>
    <div class="fctl">
      ${control}
      ${field.hint ? `<span class="lkey">${esc(field.hint)}</span>` : ''}
      ${buttons}
    </div>
  </div>`;
};

const settingGroup = (group, fields) => card(group.label, `${num(fields.length)} 项`, fields.map(settingRow).join(''));

const settingSections = d => {
  const fields = Array.isArray(d && d.fields) ? d.fields : [];
  const groups = Array.isArray(d && d.groups) ? d.groups : [];
  if (!fields.length) return alertBox('warn', '没有可改的设置', '这一版没有暴露任何运行时字段。');
  const sections = groups
    .map(group => settingGroup(group, fields.filter(field => field.group === group.id)))
    .filter(section => section);
  const orphans = fields.filter(field => !groups.some(group => group.id === field.group));
  return `<div class="grid g4">
      ${stat('可改字段', num(fields.length), `分 ${num(groups.length)} 组`)}
      ${stat('已覆盖', num(fields.filter(field => String(field.value) !== String(field.defaultValue)).length), '与 .env 默认不同的项')}
    </div>`
    + alertBox('info', '保存后立即生效', '这些字段每次调用前重新读取，不需要重启机器人。密钥与令牌不在这里：它们只能在 .env 里改。')
    + sections.join('')
    + (orphans.length ? card('其他', `${num(orphans.length)} 项`, orphans.map(settingRow).join('')) : '');
};

pages.settings = async () => {
  let body;
  try {
    body = settingSections(await api('/api/settings'));
  } catch (error) {
    body = alertBox('err', '读不到设置', reason(error));
  }
  // 页面 HTML 是 app.js 在 Promise 结算之后才写进 #main 的，所以登录面板的轮询要等
  // 一拍再启动：早一步的话 #login-text 还不存在，第一轮会被当成「面板已经关了」。
  setTimeout(loginStart, 0);
  return pageHead('设置', '运行时可改的参数都存在本地库里：覆盖只影响这一份配置，随时可以恢复成 .env 的默认值。')
    + settingNotice()
    + loginCard()
    + body;
};

action('settingSave', async (button) => {
  const name = button.dataset.name || '';
  const control = document.getElementById(`cfg-${name}`);
  if (!control) return;
  await post('/api/settings', { name, value: String(control.value) });
  settingSay(`${name} 已保存，立即生效。`);
  rerender();
});

action('settingReset', async (button) => {
  const name = button.dataset.name || '';
  await post('/api/settings', { name, value: '' });
  settingSay(`${name} 已恢复 .env 默认值。`);
  rerender();
});

action('settingToggle', async (button) => {
  const name = button.dataset.name || '';
  const on = !button.classList.contains('on');
  await post('/api/settings', { name, value: on ? 'true' : 'false' });
  settingSay(`${name} 已${on ? '打开' : '关闭'}。`);
  rerender();
});

/* --- 扫码登录 -------------------------------------------------------------
 * 让操作者不用开命令行就能给 bot 的 QQ 号登录：新号首次登录、换号都在这里点。
 *
 * 边界：浏览器从不直连 NapCat 的 WebUI（CSP connect-src 'self'；WebUI 令牌只该留在
 * Node 进程里）。页面只问本机控制台要状态和二维码图片，由服务端代理，见
 * src/napcat-webui.js。
 *
 * 轮询只在本面板存在时进行，而且只重画面板自己的两个子节点：设置页有一堆输入框，
 * 整页重绘会把用户填到一半的值冲掉（所以不能借用 app.js 的 POLLED）。
 */
const LOGIN_POLL_MS = 3000;
// NapCat 的 RefreshQRcode 内部最多等 10 秒，服务端给它 12 秒；浏览器必须比服务端更
// 有耐心，否则先超时的总是页面，用户看到「请求失败」而不是真正的原因。
const LOGIN_TIMEOUT_MS = 15000;

const LOGIN_STATE = {
  loading: ['读取中', '正在问 NapCat 现在是不是在等二维码。'],
  disabled: ['未启用', '没读到 NapCat 的 WebUI 配置（config/webui.json）。扫码登录只对本机这套 NapCat 安装有效。'],
  unreachable: ['连不上 NapCat', 'NapCat 的 WebUI 没有响应。先把 NapCat 启动起来，再回这里刷新。'],
  idle: ['没有待扫的码', 'NapCat 在线，但当前没有在等二维码。点右上角生成一张。'],
  waiting: ['等扫码', '用手机 QQ 扫描下面的二维码。扫过之后这里会自动变成「已扫码」。'],
  scanned: ['已扫码', '手机已经扫过了，请在手机上确认登录。'],
  online: ['已登录', '这个 QQ 号已经登录，机器人可以收发消息了。'],
  error: ['出错了', ''],
};

// 服务端只回稳定错误码，人话在这里。CSP 只放行 self 脚本，所以不能拿外链文档。
const LOGIN_CODE_TEXT = {
  WEBUI_DISABLED: '没读到 NapCat 的 WebUI 配置（config/webui.json）。',
  WEBUI_UNREACHABLE: '连不上 NapCat 的 WebUI，先确认它已经在跑。',
  WEBUI_AUTH_FAILED: 'WebUI 拒绝了这份令牌，检查 config/webui.json 里的 token 是否与控制台读到的一致。',
  WEBUI_2FA_REQUIRED: '这个 WebUI 开了两步验证，扫码登录需要先在 NapCat 里关掉它。',
  WEBUI_REQUEST_FAILED: 'NapCat 拒绝了这次请求，稍后再试。',
  LOGIN_ALREADY_ONLINE: '这个号已经登录了，不需要再扫码。',
  QR_REFRESH_TIMEOUT: 'NapCat 刷新二维码超时，再点一次刷新。',
  QR_REFRESH_FAILED: 'NapCat 没给出新的二维码，再点一次刷新。',
  QR_EXPIRED: '二维码过期了，点刷新换一张。',
  QR_RESTARTING: 'NapCat 正在重启登录服务，二维码会自己回来。',
  QR_NOT_FOUND: '还没有二维码可显示。',
  LOGIN_TIMEOUT: '等了 15 秒没有结果，NapCat 可能卡住了。',
};

const loginState = { status: null, notice: '', busy: false, timer: 0, bust: 0, since: 0, stamp: '' };

const loginCode = code => LOGIN_CODE_TEXT[String(code ?? '')] || `内部错误（${String(code ?? '未知')}）。`;

const loginReason = error => {
  const raw = String((error && error.message) || error || '').replace(/^HTTP \d+\s*/, '');
  return LOGIN_CODE_TEXT[raw] || reason(error);
};

const loginWaited = () => {
  const status = loginState.status || {};
  const since = Number(status.qrAt || loginState.since || 0);
  if (!since) return '';
  const gone = Date.now() - since;
  return gone < 120000 ? `${Math.max(1, Math.round(gone / 1000))} 秒` : dur(gone);
};

// 同一张码就返回 null：让已加载的 <img> 留着，否则每 3 秒重下一张图（服务端是
// no-store，浏览器不会替我们缓存）并且会闪。
const loginQrHtml = (status, state) => {
  if (state !== 'waiting' && state !== 'scanned') {
    return loginState.busy ? '<div class="muted">正在生成新的二维码…</div>' : '';
  }
  const stamp = `${loginState.bust}-${Number(status.qrAt || 0)}`;
  if (stamp === loginState.stamp) return null;
  loginState.stamp = stamp;
  return `<img id="login-qr-img" width="200" height="200" alt="QQ 登录二维码" `
    + `src="/api/login/qr.png?token=${encodeURIComponent(token)}&v=${encodeURIComponent(stamp)}">`;
};

const loginTextHtml = (status, state) => {
  const entry = LOGIN_STATE[state] || LOGIN_STATE.idle;
  const tone = { online: 'ok', waiting: 'warn', scanned: 'warn', error: 'err', unreachable: 'err' }[state] || 'muted';
  const title = state === 'online' && status.uin ? `已登录 ${status.uin}` : entry[0];
  let body = state === 'error' && status.error ? loginCode(status.error) : entry[1];
  if (state === 'waiting' || state === 'scanned') {
    const waited = loginWaited();
    if (waited) body += ` 这张码已经放了 ${waited}；NapCat 不告诉我们有效期，过期了这里会提示刷新。`;
  }
  if (status.expired && state !== 'online') body += ' NapCat 说二维码已经过期，点刷新换一张。';
  if (loginState.notice) body = `${body} ${loginState.notice}`.trim();
  return `<div><strong>${dot(tone)} ${esc(title)}</strong></div><div class="muted">${esc(body)}</div>`;
};

const loginPaint = () => {
  const box = document.getElementById('login-qr');
  const text = document.getElementById('login-text');
  if (!box || !text) { loginStop(); return; }
  const status = loginState.status || {};
  const state = loginState.status ? String(status.state || 'idle') : 'loading';
  const image = loginQrHtml(status, state);
  if (image !== null && box.innerHTML !== image) box.innerHTML = image;
  const lines = loginTextHtml(status, state);
  if (text.innerHTML !== lines) text.innerHTML = lines;
};

const loginStop = () => {
  if (loginState.timer && typeof clearInterval === 'function') clearInterval(loginState.timer);
  loginState.timer = 0;
};

const loginStart = () => {
  loginStop();
  loginState.status = null;
  loginState.notice = '';
  loginState.stamp = '';
  loginState.since = 0;
  loginPaint();
  if (typeof setInterval === 'function') loginState.timer = setInterval(loginTick, LOGIN_POLL_MS);
  loginTick();
};

const loginTick = async () => {
  // 面板已经不在了就别再问：这是「只在面板打开时轮询」的落实点。
  if (!document.getElementById('login-text')) { loginStop(); return; }
  if (document.hidden) return;
  try {
    const status = await api('/api/login/status');
    loginState.status = status && typeof status === 'object' ? status : { state: 'error' };
  } catch (error) {
    loginState.status = { state: 'error' };
    loginState.notice = reason(error);
  }
  loginPaint();
};

// 写操作要请求头令牌（core.js 的 post 没有超时控制，而刷新可能要等 10 秒以上）。
const loginPost = async path => {
  const control = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = control ? setTimeout(() => control.abort(), LOGIN_TIMEOUT_MS) : 0;
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: '{}',
      ...(control ? { signal: control.signal } : {}),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new Error('LOGIN_TIMEOUT');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const loginCard = () => card('扫码登录', '给机器人的 QQ 号登录或换号',
  '<div id="login-qr"></div><div id="login-text"><div class="muted">正在读取登录状态…</div></div>',
  '<button type="button" class="btn btn-primary" data-act="loginRefresh">刷新二维码</button>');

action('loginRefresh', async () => {
  if (loginState.busy) return;
  loginState.busy = true;
  loginState.notice = '正在刷新二维码，NapCat 最多要 10 秒，请稍等…';
  loginPaint();
  try {
    const result = await loginPost('/api/login/qr');
    loginState.bust += 1;
    loginState.since = Date.now();
    const ok = Boolean(result && result.ok);
    loginState.notice = ok ? '' : loginCode((result && result.error) || 'QR_RESTARTING');
    // 乐观地先当成「在等码」，紧跟着的那次 tick 会用真实状态覆盖它。
    if (ok) loginState.status = { state: 'waiting', online: false, qrAt: Number(result.qrAt || loginState.since) };
  } catch (error) {
    loginState.notice = `刷新没成功：${loginReason(error)}`;
  } finally {
    loginState.busy = false;
  }
  loginPaint();
  await loginTick();
});
