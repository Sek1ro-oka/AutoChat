/* 空间说说（I-09）：机器人自己发的 QQ 空间说说在这里留一份记录，发出去的那条可以一键删除。
 * 拦截与失败的行不显示正文——被出站闸拒掉的文字不该在控制台再出现一遍。
 * 删除先真删 QQ 空间里那条，成功了才把本地记录标成「已删除」，绝不报假成功。
 */

const QZONE_STATUS = {
  sent: ['已发布', 'ok'],
  drafted: ['草稿（干跑）', 'brand'],
  blocked: ['已拦截', 'warn'],
  failed: ['失败', 'err'],
  deleted: ['已删除', 'muted'],
};

const QZONE_VISIBLE = { 1: '1 · 公开', 4: '4 · 好友', 16: '16 · 仅自己', 64: '64 · 密码', 128: '128 · 指定人' };

// blocked 的 reason 是 qzone-guard.js 的 GUARD_REASONS，failed 的来自 qzone.js 的失败语义。
const QZONE_REASON = {
  length: '长度不在 8–200 字之间',
  groupid: '含白名单群号',
  number: '含 5–12 位连续数字（疑似 QQ 号 / 手机号）',
  link: '含链接',
  markup: '含 @、【】或 CQ 码',
  term: '命中屏蔽词',
  repeat: '与最近说过的太像',
  no_tid: '协议端没有返回 tid，无法确认这条发出去了',
  rate_limited: '被协议端限流（retcode -10000），当天停止发布',
  unavailable: '协议端不可用（认证失败或接口不存在），本次进程内已停用',
  send_failed: '网络错误或超时，没有重试',
  dry_run: '干跑：只生成、没有发送',
  console: '在控制台删除',
};

// 删除失败一律把真实原因说清楚；只有拿到 200 才说删掉了。
const QZONE_DELETE_TEXT = {
  QZONE_POST_NOT_FOUND: '记录里找不到这一条，它可能已被裁掉（只保留最近 50 条）',
  QZONE_POST_ALREADY_DELETED: '这条已经删过了，不用再删一次',
  QZONE_POST_NO_TID: '这条没有 tid：干跑或拦截的记录从来没发到 QQ 空间，协议端没有可删的对象',
  QZONE_DELETE_UNAVAILABLE: '控制台现在连不上协议端（NapCat 没连上或已断开），这次没有删',
  QZONE_DELETE_TIMEOUT: '协议端超时没回话，这次没有删',
  QZONE_DELETE_REJECTED: '协议端拒绝了这个删除（retcode 非 0）',
  QZONE_DELETE_FAILED: '删除没有成功',
  header_token_required: '这个动作只接受请求头里的令牌',
  origin_rejected: '只接受从本机控制台页面发起的写入',
};

const qzoneState = { text: '', level: 'ok' };

// core.js 的 post() 只保留 error 字段，会把协议端原话（detail）丢掉，所以这里自己发。
const qzonePost = async (path, body) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (response.ok) return data;
  const error = new Error(String((data && data.error) || `HTTP ${response.status}`));
  error.detail = String((data && data.detail) || '');
  throw error;
};

const qzoneExplain = (error) => {
  const code = String((error && error.message) || '');
  const text = QZONE_DELETE_TEXT[code] || explain(code);
  const detail = String((error && error.detail) || '').trim();
  return detail ? `${text}（协议端原话：${detail}）` : text;
};

const qzoneSay = (text, level) => {
  qzoneState.text = String(text || '');
  qzoneState.level = level === 'err' ? 'err' : 'ok';
};

const qzoneNotice = () => (qzoneState.text
  ? `<div class="msg msg-${qzoneState.level}">${esc(qzoneState.text)}</div>`
  : '');

const qzoneAgo = (ms) => {
  const total = Math.max(0, Number(ms || 0));
  return total < 60000 ? '刚刚' : `${dur(total)}前`;
};

const qzoneStats = (data) => {
  const today = data.today || {};
  const sent = Number(today.sent || 0);
  const drafted = Number(today.drafted || 0);
  const used = Number(today.used || 0);
  const limit = Number(today.limit || 0);
  const left = Math.max(0, limit - used);
  const sentHint = drafted > 0
    ? `另有 ${num(drafted)} 条干跑草稿也占着今日额度（共 ${num(used)} / ${num(limit)}）`
    : `北京时间零点重置，今日额度还剩 ${num(left)} 条`;
  const lastHint = data.lastSentAt ? time(data.lastSentAt) : '真发出去一条之后才有';
  const dryHint = data.dryRun
    ? '只生成草稿，协议端一条都收不到'
    : (data.enabled ? '真发：过了出站闸就直接发到空间' : '总开关关着，什么都不做');
  return `<div class="grid g4">
    ${stat('今日已发', esc(`${num(sent)} / ${num(limit)}`), sentHint)}
    ${stat('上次发布', esc(data.lastSentAt ? qzoneAgo(Date.now() - data.lastSentAt) : '还没有'), lastHint)}
    ${stat('干跑', esc(data.dryRun ? '开' : '关'), dryHint)}
  </div>`;
};

const qzoneBanner = (data) => {
  if (!data.enabled) {
    return alertBox('warn', '功能默认关闭，未开启时什么都不会发生',
      '空间说说默认关闭：总开关关着的时候，机器人既不挑素材也不调模型，一条说说都不会发出去。'
      + '要打开请去「设置 → 空间说说」，第一次建议同时打开「只生成不发布」，看几天草稿再关。');
  }
  if (data.dryRun) {
    return alertBox('info', '总开关已开，但还在干跑',
      '「只生成不发布」开着：下面出现的只会是草稿，协议端一条都收不到，也没有 tid 可删。'
      + '措辞确认无误后，去设置页关掉干跑才会真的发出去。');
  }
  return alertBox('warn', '正在真实发布',
    `总开关和干跑都是关的：内容过了出站闸就会真的发到你的 QQ 空间，每天最多 ${num(data.maxPerDay)} 条、`
    + `两条至少隔 ${num(data.minGapHours)} 小时、只在 ${data.hours} 点之间发。发出去的行可以直接在这里删掉。`);
};

const qzoneText = (post) => {
  if (post.status === 'blocked' || post.status === 'failed') {
    const why = QZONE_REASON[post.reason] || post.reason || '原因未知';
    const label = post.status === 'blocked' ? '拦截原因' : '失败原因';
    return `<b>（未发布）</b><div class="fhint">${esc(label)}：${esc(why)}</div>`;
  }
  return esc(post.text);
};

const qzoneAction = (post) => {
  if (post.status === 'sent' && post.removable) {
    return `<button type="button" class="btn btn-sm btn-danger" data-act="qzoneDelete" data-id="${esc(post.id)}">删除</button>`;
  }
  if (post.status === 'sent') return '<span class="muted">没有 tid，删不了</span>';
  if (post.status === 'deleted') return '<span class="muted">已删除</span>';
  if (post.status === 'drafted') return '<span class="muted">只进列表，没发出去</span>';
  return '<span class="muted">已丢弃</span>';
};

const qzoneTable = (data) => table(
  ['时间', '正文', '状态', '可见范围', '操作'],
  (data.posts || []).map(post => [
    `<span class="mono">${esc(time(post.at))}</span>`,
    qzoneText(post),
    badge(...(QZONE_STATUS[post.status] || [post.status || '未知', 'muted'])),
    esc(QZONE_VISIBLE[post.ugcRight] || String(post.ugcRight ?? '')),
    qzoneAction(post),
  ]),
  { empty: '还没有记录。功能默认关闭；开着之后每评估一次，无论发没发出去都会在这里留一行。' },
);

pages.qzone = async () => {
  const head = pageHead('空间说说', '机器人自己发的 QQ 空间说说：这里看它写过什么、发没发出去，以及删掉已经发出去的那一条。');
  let data;
  try {
    data = await api('/api/qzone/posts');
  } catch (error) {
    return head + alertBox('err', '读不到说说记录', reason(error));
  }
  const sub = `最近 ${num((data.posts || []).length)} 条 · 上限 ${num(data.maxPerDay)} 条/天 · `
    + `间隔 ≥ ${num(data.minGapHours)} 小时 · 时段 ${data.hours}`;
  return head
    + qzoneStats(data)
    + qzoneBanner(data)
    + qzoneNotice()
    + card('最近说说', sub, qzoneTable(data))
    // 这句是常驻的：不管开关现在是什么状态，页面上都得有一处说明默认值。
    + '<div class="fhint">功能默认关闭，未开启时什么都不会发生。</div>';
};

action('qzoneDelete', async (button) => {
  const id = String((button && button.dataset && button.dataset.id) || '');
  if (!id) return;
  button.disabled = true;
  button.textContent = '删除中…';
  try {
    await qzonePost('/api/qzone/delete', { id });
    qzoneSay('已经从 QQ 空间删掉了，这条记录也标成了「已删除」。', 'ok');
  } catch (error) {
    qzoneSay(`没有删掉：${qzoneExplain(error)}`, 'err');
  }
  rerender();
});
