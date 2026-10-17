/* 外壳：页签路由、渲染循环、唯一的事件入口、主题与顶栏状态。
 *
 * 整个控制台只有这里装 DOM 监听器（CSP 不许内联 on*）。点击走一条委托链：
 *   [data-page] → 切页；[data-act] → 查 core.js 的动作表。
 * 写入类控件（input/select/textarea）的 change 单独一条，因为 click 不覆盖键盘输入与粘贴。
 */

const PAGES = [
  { id: 'overview', title: '概览' },
  { id: 'model', title: '模型与 API Key' },
  { id: 'personas', title: '人格' },
  { id: 'groups', title: '群管理' },
  { id: 'activity', title: '活跃度与静默' },
  { id: 'assets', title: '素材库' },
  { id: 'cost', title: '计费看板' },
  { id: 'logs', title: '日志与健康' },
  { id: 'settings', title: '系统设置' },
];

// 这四页是只读看板，可以每 3 秒自己刷新；带编辑器或表单的页面不轮询，
// 否则用户打到一半的字会被重绘冲掉。
const POLLED = new Set(['overview', 'model', 'cost', 'logs']);

let current = 'overview';

const nodes = selector => {
  const found = typeof document.querySelectorAll === 'function' ? document.querySelectorAll(selector) : [];
  return found ? Array.from(found) : [];
};

const setHtml = (selector, html) => {
  const node = $(selector);
  if (node) node.innerHTML = html;
};

const chip = (selector, level, text) => {
  const node = $(selector);
  if (node) node.innerHTML = dot(level) + esc(text);
};

// 顶栏四个 chip 的数据全部来自 /api/summary，拿不到就保持「—」，不猜。
const applyChips = data => {
  const connection = data.connection || {};
  chip('#conn', connection.ready ? 'ok' : connection.reconnecting ? 'warn' : 'err',
    connection.ready ? 'OneBot 已连接' : connection.reconnecting ? `重连中（第 ${num(connection.retry)} 次）` : 'OneBot 未连接');
  const switches = data.switches || {};
  const model = data.model || {};
  // 顶栏这一格也要分得清「我自己停的」和「它自己熔断的」：原因由 /api/summary 带出来，
  // 没记录就只说停，不猜（E-10）。
  chip('#modelchip', switches.enabled ? 'ok' : 'err',
    switches.enabled ? `${model.name || DASH} 回复中` : stopLabel(switches.enabledReason));
  const budget = data.budget || {};
  chip('#spendchip', 'warn', `今日 ${cny(budget.used)} / ${cny(budget.limitMicro, 2)}`);
  const stamp = $('#stamp');
  if (stamp) stamp.textContent = time(data.generatedAt);
};

// 进度条这类「宽度随数据变」的尺寸不能用 style=""（CSP 是 style-src 'self'，
// 标记里的内联样式会被丢弃），统一由 data-width 在写进 DOM 之后用 CSSOM 设置。
const paintWidths = root => {
  for (const node of nodes('[data-width]')) {
    const value = Number(node.dataset ? node.dataset.width : NaN);
    if (!Number.isFinite(value)) continue;
    if (node.style) node.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }
  return root;
};

const render = async () => {
  const main = $('#main');
  if (!main) return;
  const render_page = pages[current] || pages.overview;
  try {
    main.innerHTML = await render_page();
  } catch (error) {
    main.innerHTML = `<div class="page active">${pageHead(PAGES.find(p => p.id === current)?.title || '出错了', '')}` +
      `${alertBox('err', '这个页面没能加载出来', reason(error))}</div>`;
  }
  paintWidths(main);
};

const show = async name => {
  current = pages[name] ? name : 'overview';
  for (const button of nodes('[data-page]')) {
    const on = button.dataset ? button.dataset.page === current : false;
    if (button.classList) button.classList.toggle('active', on);
  }
  try {
    history.replaceState(null, '', '#' + current);
  } catch {
    // 有些宿主环境不给 replaceState；地址栏不同步不影响页面本身。
  }
  await render();
};

const toggleTheme = () => {
  const root = document.documentElement;
  if (!root) return;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try {
    localStorage.setItem('autochat.console.theme', next);
  } catch {
    // 存不下就只在这次会话里生效。
  }
};

const savedTheme = (() => {
  try {
    return localStorage.getItem('autochat.console.theme');
  } catch {
    return null;
  }
})();
if (savedTheme && document.documentElement) document.documentElement.setAttribute('data-theme', savedTheme);

REPAINT.now = render;

action('theme', toggleTheme);
action('refresh', () => render());
action('page', element => show(element.dataset.page));

const closestAct = target => {
  let node = target;
  while (node && node.getAttribute) {
    if (node.getAttribute('data-act')) return node;
    node = node.parentNode;
  }
  return null;
};

const dispatch = (target, kind) => {
  const element = closestAct(target);
  if (!element) return false;
  const name = element.getAttribute('data-act');
  const handler = ACTIONS.get(name);
  if (!handler) return false;
  const result = handler(element, kind);
  if (result && typeof result.catch === 'function') {
    result.catch(error => toast(reason(error), 'err'));
  }
  return true;
};

if (typeof document.addEventListener === 'function') {
  document.addEventListener('click', event => {
    const target = event.target;
    const nav = target && target.closest ? target.closest('[data-page]') : null;
    if (nav) {
      event.preventDefault();
      show(nav.dataset.page);
      return;
    }
    dispatch(target, 'click');
  });
  document.addEventListener('change', event => {
    if (dispatch(event.target, 'change')) event.stopPropagation?.();
  });
}

const boot = async () => {
  const main = $('#main');
  if (!token) {
    if (main) {
      main.innerHTML = `<div class="page active">${pageHead('缺少访问令牌', '控制台的所有数据接口都要求令牌。')}` +
        `${alertBox('warn', '怎么拿到带令牌的地址',
          '令牌写在 .env 的 CONSOLE_TOKEN 里。用它打开 /?token=<令牌>，令牌会存进 localStorage 并立刻从地址栏抹掉。')}</div>`;
    }
    return;
  }
  const initial = String((typeof location.hash === 'string' && location.hash.slice(1)) || '');
  await show(pages[initial] ? initial : 'overview');
  if (typeof setInterval === 'function') {
    setInterval(() => {
      if (POLLED.has(current)) render();
    }, 3000);
  }
};

boot();
