/* T-020：概览页「服务」卡片（重启 / 停止）的前端行为。
 *
 * 单独成文件，不塞进 test/console-pages.test.js：那个文件现在就是 399 内容行，而每文件上限
 * 是 400 —— 没有地方可加。新增文件是纯增量，也不会和并行任务抢同一个文件。
 *
 * 两个刻意的选择：
 * 1) 用 node:http 起一个只答 /api/service 的桩，**不向真实 console fixture 发** restart/stop：
 *    那两个接口会真的调度进程退出，在测试里点一下可能把测试进程自己杀掉。
 * 2) app.js 的两个接触点（applyChips / REPAINT.now）在这里用桩代替：被测的是 pages-overview.js，
 *    轮询与事件派发由 console-pages.test.js 覆盖。计时器也换成可手动触发的版本，这样才能证明
 *    「2 秒一探」「3 秒复原」「30 秒放弃」是代码里写死的值，而不是靠 sleep 撞运气。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const TOKEN = 'test-console-token-1234';

// 契约（T-019）：GET /api/service 读状态；POST /api/service/restart|stop 写；未托管时写接口回 409。
const stub = async t => {
  const api = {
    managed: true, pid: 4242, supervisorPid: 4200, uptimeMs: 11520000,
    answer: true,     // false → GET 500，模拟进程已经不在了
    postStatus: 200,  // 409 → 未托管
    seen: [],
  };
  const server = createServer((req, res) => {
    api.seen.push({ path: req.url, method: req.method, token: req.headers['x-console-token'] });
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST') {
      if (api.postStatus === 409) return json(409, { error: 'SERVICE_NOT_MANAGED' });
      return json(200, { ok: true, action: req.url.endsWith('/stop') ? 'stop' : 'restart' });
    }
    if (req.url.startsWith('/api/service')) {
      if (!api.answer) return json(500, { error: 'gone' });
      return json(200, {
        managed: api.managed, pid: api.pid, supervisorPid: api.supervisorPid,
        uptimeMs: api.uptimeMs, restartable: api.managed,
      });
    }
    // 概览页的其余数据：这里不关心，给最小可用形状，免得卡片之外的渲染分支抛错。
    if (req.url.startsWith('/api/summary')) {
      return json(200, {
        switches: {}, model: {}, connection: {}, budget: {}, participants: [], groups: [],
        uptimeMs: 0, generatedAt: 0,
      });
    }
    if (req.url.startsWith('/api/settings')) return json(200, { fields: [] });
    if (req.url.startsWith('/api/logs')) return json(200, { logs: [] });
    if (req.url.startsWith('/api/sessions')) return json(200, { sessions: [] });
    return json(404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(resolve);
  }));
  api.base = `http://127.0.0.1:${server.address().port}`;
  return api;
};

const load = base => {
  const calls = [];
  const timers = [];
  const toastNode = { textContent: '', className: '' };
  const context = vm.createContext({
    document: {
      querySelector: selector => (selector === '#toast' ? toastNode : null),
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, before() {} }),
    },
    location: { search: '', pathname: '/' },
    history: { replaceState() {} },
    localStorage: { getItem: () => TOKEN, setItem() {}, removeItem() {} },
    window: {},
    fetch: (target, init = {}) => {
      const path = String(target);
      calls.push({
        path,
        method: (init.method || 'GET').toUpperCase(),
        body: init.body || null,
        token: (init.headers || {})['x-console-token'],
      });
      return fetch(base + path, init);
    },
    // 定时器不真跑：只登记，由测试按毫秒数取出来手动触发。
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length;
    },
    clearTimeout: id => {
      const timer = timers[id - 1];
      if (timer) timer.cleared = true;
    },
    setInterval: () => 0,
    clearInterval() {},
    applyChips: () => {}, // app.js 的职责（顶栏 chip），与这张卡片无关
    console, URLSearchParams, URL, Blob,
  });
  for (const name of ['core.js', 'pages-overview.js']) {
    const file = new URL(`../src/console/public/${name}`, import.meta.url);
    new vm.Script(readFileSync(file, 'utf8'), { filename: name }).runInContext(context);
  }
  vm.runInContext('globalThis.__pages = pages; globalThis.__actions = ACTIONS; globalThis.__service = SERVICE;', context);
  return {
    context,
    calls,
    toastNode,
    pages: context.__pages,
    state: context.__service,
    click: value => context.__actions.get('serviceAction')({ dataset: { value } }),
    render: async () => context.__pages.overview(),
    lastTimer: ms => timers.filter(item => item.ms === ms).at(-1),
    fire: async timer => {
      assert.ok(timer, '找不到该定时器');
      assert.equal(timer.cleared, false, '这个定时器已经被撤销，不该再触发');
      const result = timer.fn();
      if (result && typeof result.then === 'function') await result;
    },
  };
};

// 卡片排在页面最后：从它的标题切到结尾就是这张卡，断言只看它，不误伤别的卡片。
const cardOf = html => html.slice(html.indexOf('class="card-title">服务'));

test('the service card shows managed state, pid and a readable uptime, after the existing cards', async t => {
  const service = await stub(t);
  const ui = load(service.base);
  const html = await ui.render();
  assert.match(html, /已托管/);
  assert.match(html, /4242/);
  assert.match(html, /3小时12分/); // 11520000ms 要说成 3 小时 12 分，不许甩原始毫秒数
  assert.match(html, /supervisor/);
  const card = cardOf(html);
  assert.match(card, /data-value="restart"/);
  assert.match(card, /data-value="stop"/);
  assert.doesNotMatch(card, /disabled/);
  assert.match(card, /点第一次只是确认/);
  // 不许插到最前面抢位置：服务卡片必须在既有卡片之后。
  assert.ok(html.indexOf('群与下次清理') < html.indexOf('data-act="serviceAction"'));
});

test('an unmanaged process gets both buttons disabled, with the reason written out', async t => {
  const service = await stub(t);
  service.managed = false;
  service.pid = null;
  service.uptimeMs = 0;
  const ui = load(service.base);
  const html = await ui.render();
  assert.match(html, /未托管/);
  const card = cardOf(html);
  assert.match(card, /当前不是由 supervisor 启动的，重启会让它直接退出、不会自动回来。请用 start.cmd 启动。/);
  assert.match(card, /data-value="restart" disabled/);
  assert.match(card, /data-value="stop" disabled/);
  await ui.click('restart');
  await ui.click('stop');
  assert.equal(ui.calls.filter(item => item.method === 'POST').length, 0, '未托管时点下去不许发写请求');
  assert.match(ui.toastNode.textContent, /不能重启或停止/);
});

test('an unreadable service endpoint disables both buttons instead of offering them', async t => {
  const service = await stub(t);
  service.answer = false;
  const ui = load(service.base);
  const html = await ui.render();
  assert.match(html, /拿不到服务状态/);
  const card = cardOf(html);
  assert.match(card, /data-value="restart" disabled/);
  assert.match(card, /data-value="stop" disabled/);
  await ui.click('restart');
  assert.equal(ui.calls.filter(item => item.method === 'POST').length, 0);
});

test('restart needs a second click, and the first one is forgotten after three seconds', async t => {
  const service = await stub(t);
  const ui = load(service.base);
  await ui.render();
  await ui.click('restart');
  assert.equal(ui.calls.filter(item => item.method === 'POST').length, 0, '第一次点只是确认，不许发请求');
  assert.match(cardOf(await ui.render()), /确认重启？/);
  assert.match(cardOf(await ui.render()), /is-armed/);
  const arm = ui.lastTimer(3000);
  assert.ok(arm, '二次确认要挂一个 3 秒的复原定时器');
  await ui.fire(arm);
  assert.equal(ui.state.confirm, '', '3 秒不再点就要自己复原');
  assert.doesNotMatch(cardOf(await ui.render()), /确认重启？/);
});

test('a confirmed restart reports pending, probes every two seconds, then reports recovery', async t => {
  const service = await stub(t);
  const ui = load(service.base);
  await ui.render();
  await ui.click('restart');
  await ui.click('restart');
  const posts = ui.calls.filter(item => item.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/service/restart');
  assert.equal(posts[0].token, TOKEN, '写接口必须带请求头令牌');
  assert.equal(posts[0].body, '{}');
  assert.equal(ui.state.phase, 'pending');
  const waiting = cardOf(await ui.render());
  assert.match(waiting, /已请求重启，页面将在几秒后自动重连/);
  // 等回执期间两个按钮必须锁住：这时候再点一下，等于对同一个进程排两次队。
  assert.match(waiting, /data-value="restart" disabled/);
  assert.match(waiting, /data-value="stop" disabled/);
  const probe = ui.lastTimer(2000);
  assert.ok(probe, '回包之后要挂一个 2 秒的探测');
  await ui.fire(probe); // 桩还在答：这次重启在两次探测之间就完成了
  assert.equal(ui.state.phase, 'recovered');
  assert.match(cardOf(await ui.render()), /已恢复/);
});

test('the card gives up after thirty seconds and points at the supervisor window', async t => {
  const service = await stub(t);
  const ui = load(service.base);
  await ui.render();
  await ui.click('restart');
  await ui.click('restart');
  service.answer = false; // 进程真的没了
  ui.state.since = Date.now() - 31000; // 把 30 秒直接拨过去，不必真等
  await ui.fire(ui.lastTimer(2000));
  assert.equal(ui.state.phase, 'lost');
  assert.match(cardOf(await ui.render()), /没有自动恢复，请检查 supervisor 窗口/);
  assert.equal(ui.state.probeTimer, null, '放弃之后不许再挂探测');
});

test('stop counts as done when the endpoint stops answering', async t => {
  const service = await stub(t);
  const ui = load(service.base);
  await ui.render();
  await ui.click('stop');
  await ui.click('stop');
  const post = ui.calls.filter(item => item.method === 'POST').at(-1);
  assert.equal(post.path, '/api/service/stop');
  assert.match(cardOf(await ui.render()), /已请求停止/);
  service.answer = false;
  await ui.fire(ui.lastTimer(2000));
  assert.equal(ui.state.phase, 'recovered');
  assert.match(cardOf(await ui.render()), /已停止/);
});

test('a 409 on the write is explained in chinese, never shown as a bare code', async t => {
  const service = await stub(t);
  const ui = load(service.base);
  await ui.render(); // 这一帧还是「托管」，按钮可点
  service.managed = false;
  service.postStatus = 409; // 但按下第二次时状态已经变了
  await ui.click('restart');
  await ui.click('restart');
  assert.equal(ui.state.phase, 'failed');
  const html = await ui.render();
  assert.match(html, /这个进程不是 supervisor 拉起来的/);
  assert.doesNotMatch(html, /SERVICE_NOT_MANAGED/);
  assert.match(cardOf(html), /data-value="restart" disabled/, '失败之后按钮要回到禁用态');
});
