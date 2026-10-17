/* 模型与 API Key（只读）。数据只来自 `GET /api/config` 与 `GET /api/summary`：
 * 密钥在服务端已打码（`credentials.*`），这里不做二次处理也不猜真值。
 * 本页在 app.js::POLLED 里，可以每 3 秒重绘——所以不放输入框，避免打一半被冲掉。
 */

const priceOf = value => (value === null || value === undefined || value === ''
  ? DASH
  : `¥${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 4 })}/百万`);

const yesNo = value => (value === undefined || value === null ? DASH : (value ? '支持' : '不支持'));

const profileRow = profile => ({
  live: profile.id === 'default' ? '默认' : '备选',
  cells: [
    `<code>${esc(profile.id)}</code>`,
    `<strong>${esc(profile.model)}</strong>`,
    `<span class="dim">${esc(profile.baseUrl)}</span>`,
    priceOf(profile.inputPrice),
    priceOf(profile.outputPrice),
    profile.cacheHitPrice === null || profile.cacheHitPrice === undefined ? DASH : priceOf(profile.cacheHitPrice),
    num(profile.contextTokens),
    num(profile.maxOutput),
    yesNo(profile.supportsVision),
    yesNo(profile.supportsSearch),
  ],
});

pages.model = async () => {
  const [cfg, sum] = await Promise.all([
    api('/api/config'),
    api('/api/summary').catch(() => ({})),
  ]);
  const config = cfg.config || {};
  const credentials = cfg.credentials || {};
  const profiles = Array.isArray(cfg.modelProfiles) ? cfg.modelProfiles : [];
  const modelName = (sum.model && sum.model.name) || config.model || DASH;
  const live = profiles.find(profile => profile.model === modelName) || profiles[0] || null;

  const stats = `<div class="g4">${[
    stat('当前模型', esc(modelName), '来自运行中的配置'),
    stat('模型档案', num(profiles.length), `默认 + ${Math.max(0, profiles.length - 1)} 个备选`),
    stat('输入价', esc(priceOf(live && live.inputPrice)), '每百万 token'),
    stat('输出价', esc(priceOf(live && live.outputPrice)), '每百万 token'),
  ].join('')}</div>`;

  const secrets = card('连接与密钥', '密钥只返回掩码，全量值在 .env 里',
    kv([
      ['模型名', esc(config.model || DASH)],
      ['接口地址', `<code>${esc(config.baseUrl || DASH)}</code>`],
      ['API Key', `<code>${esc(credentials.apiKey || DASH)}</code>`],
      ['OneBot 令牌', `<code>${esc(credentials.onebotToken || DASH)}</code>`],
      ['控制台令牌', `<code>${esc(credentials.consoleToken || DASH)}</code>`],
      ['WebSocket', `<code>${esc(config.wsUrl || DASH)}</code>`],
    ])
    + alertBox('info', '为什么这里改不了', '密钥、接口地址与模型档案属于启动期配置，改 .env 后重启才生效。价格、预算与生成限额是运行期字段，在「系统设置」页改，保存后立即生效。'));

  const tableRows = profiles.map(profileRow);
  const list = card('模型档案', `共 ${num(profiles.length)} 个；切换用 QQ 里的 /模型 命令`,
    table(
      ['标识', { label: '模型', num: false }, '接口地址', { label: '输入价', num: true }, { label: '输出价', num: true },
        { label: '缓存价', num: true }, { label: '上下文', num: true }, { label: '最大输出', num: true }, '视觉', '联网'],
      tableRows.map(row => row.cells),
      { empty: '没有读到模型档案。' },
    ));

  const limits = card('生成限额', '超出会被截断，不影响计费口径',
    kv([
      ['单次最大输出', `${num(config.maxOutput)} tokens`],
      ['上下文上限', `${num(config.contextTokens)} tokens`],
      ['请求超时', config.timeoutMs === undefined ? DASH : `${num(config.timeoutMs)} ms`],
      ['图片预留', live && live.imageInputReserve !== undefined ? `${num(live.imageInputReserve)} tokens` : DASH],
      ['思考过程', live ? yesNo(live.sendThinking) : DASH],
      ['价格核对日', live && live.priceDate ? esc(live.priceDate) : DASH],
    ]));

  const daily = card('每日预算', '费用口径见「计费看板」',
    kv([
      ['预算上限', `${cny(config.budgetMicro)}`],
      ['输出价（旧版字段）', priceOf(config.outputPrice)],
      ['缓存价（旧版字段）', priceOf(config.cacheHitPrice)],
      ['谷时折扣比', config.offPeakRatio === undefined ? DASH : `${Number(config.offPeakRatio).toFixed(2)} ×`],
    ]));

  return pageHead('模型与 API Key', '接口地址、密钥与模型档案来自启动期配置；这里只读，避免误改正在跑的连接。价格与限额在「系统设置」页改。')
    + stats
    + `<div class="g2">${secrets}${limits}</div>`
    + list
    + daily;
};

REPAINT.model = () => {};
