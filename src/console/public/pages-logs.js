/* 日志：只读 Server-Sent 事件名、时间与结构化详情。
 * detail 由后端 src/console/logs.js 处理过：最多 8 个键、每个值截 120 字、疑似密钥显示 [已隐去]，
 * 所以这一页可以放心展开。聊天内容仍然不在这里。 */

const logState = { limit: '120', q: '' };

const logLimit = () => (logState.limit === '1000' ? 1000 : Number(logState.limit) || 120);

// readLogs 的 time 是 ISO 字符串，core 的 time() 只吃毫秒数，所以这里自己格式化。
const logStamp = (value) => {
  const at = new Date(String(value || ''));
  if (Number.isNaN(at.getTime())) return DASH;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

// detail 是纯对象（后端已脱敏 + 截断），键按字母序给过来，这里只负责拼成 k=v。
const logDetail = row => {
  const detail = row && row.detail;
  if (!detail || typeof detail !== 'object') return DASH;
  const pairs = Object.keys(detail).map(key => `${esc(key)}=${esc(String(detail[key]))}`);
  return pairs.length ? `<span class="mono">${pairs.join(' · ')}</span>` : DASH;
};

// core.js 的 table(headers, rows) 吃的是「每行一个单元格数组」，不是整行 <tr> 字符串；
// 以前这里传的是 <tr>，只要有一条日志就会 TypeError: cells.map is not a function，整页渲染失败。
const logRow = row => [
  `<span class="mono nowrap">${logStamp(row.time)}</span>`,
  `<span class="mono">${esc(row.event || '')}</span>`,
  logDetail(row),
];

pages.logs = async () => {
  const head = pageHead('日志', '只记录事件名、时间与脱敏后的详情：不含聊天内容，也不含密钥与令牌。')
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
    + card('事件', '新的在最上面', table(['时间', '事件', '详情'], rows.map(logRow), { empty }), '')
    + alertBox('info', '这些字段是什么', '详情来自事件本身的结构化字段：最多 8 个键，每个值截到 120 字，疑似密钥显示 [已隐去]。聊天内容与完整报文不在这里，需要时去读 logs/*.jsonl。');
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
