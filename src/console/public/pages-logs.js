/* 日志：只读事件流。readLogs 只吐 { time, event }（不含聊天内容与密钥），
 * 所以这一页不做「详情」「导出」，也不假装有 detail 字段可看。
 */

const logState = { limit: '120', q: '' };

const logLimit = () => (logState.limit === '1000' ? 1000 : Number(logState.limit) || 120);

// readLogs 的 time 是 ISO 字符串，core 的 time() 只吃毫秒数，所以这里自己格式化。
const logStamp = (value) => {
  const at = new Date(String(value || ''));
  if (Number.isNaN(at.getTime())) return DASH;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

const logRow = (row) => `<tr>
    <td class="nowrap mono">${logStamp(row.time)}</td>
    <td><span class="mono">${esc(row.event || '')}</span></td>
  </tr>`;

pages.logs = async () => {
  const head = pageHead('日志', '只记录事件名：不含聊天内容，也不含密钥与令牌。')
    + `<div class="toolbar">
      ${seg([{ value: '120', label: '最近 120 条' }, { value: '300', label: '300 条' }, { value: '1000', label: '1000 条' }], logState.limit, 'logLimit')}
      <label class="lbl">筛选事件 <input id="log-q" type="text" value="${esc(logState.q)}" placeholder="例如 slang_extracted" data-act="logSearch"></label>
    </div>`;
  let d;
  try {
    d = await api(`/api/logs?limit=${logLimit()}`);
  } catch (error) {
    return head + alertBox('err', '读不到日志', reason(error));
  }
  const all = Array.isArray(d && d.logs) ? d.logs : [];
  const q = logState.q.trim().toLowerCase();
  const rows = q ? all.filter(row => String(row.event || '').toLowerCase().includes(q)) : all;
  const empty = all.length ? `没有事件名里带「${q}」的记录。` : '还没有日志：机器人启动并处理消息后，这里会出现事件。';
  return head
    + `<div class="grid g4">
      ${stat('本次读取', num(all.length), `上限 ${num(logLimit())} 条`)}
      ${stat('筛选后', num(rows.length), q ? `匹配「${q}」` : '未筛选')}
    </div>`
    + card('事件', '新的在最上面', table(['时间', '事件'], rows.map(logRow), { empty }), '')
    + alertBox('info', '为什么看不到更多字段', '这一页刻意只暴露 { 时间, 事件 }：日志里的 detail 记录的是目标标签、路径和错误原因，不在控制台展开。');
};

action('logLimit', (button) => {
  logState.limit = button.dataset.value || '120';
  rerender();
});

action('logSearch', (input, kind) => {
  if (kind !== 'change') return;
  logState.q = String(input.value || '');
  rerender();
});
