/* 素材库：把原「表情包」与「黑话」两个页签合成一页（设计稿的合并）。
 * 两个库各有自己的接口，一次只读当前子页的那一个——没有必要为了画一个子页拉两份数据。
 * 子页的视图函数分别在 assets-stickers.js / assets-slang.js 里。
 */

const assetsState = { tab: 'stickers', filter: 'all', entry: null, notice: '', bad: false };

const assetSay = (text, bad = false) => {
  assetsState.notice = String(text || '');
  assetsState.bad = Boolean(bad);
};

const assetNotice = () => (assetsState.notice
  ? alertBox(assetsState.bad ? 'err' : 'ok', assetsState.bad ? '没做成' : '已完成', assetsState.notice)
  : '');

action('assetsTab', (button) => {
  const tab = button.dataset.value === 'slang' ? 'slang' : 'stickers';
  if (tab === assetsState.tab) return;
  assetsState.tab = tab;
  assetsState.filter = 'all';
  assetsState.entry = null;
  assetsState.notice = '';
  assetsState.bad = false;
  rerender();
});

pages.assets = async () => {
  const slang = assetsState.tab === 'slang';
  const head = pageHead('素材库', '机器人从群里学到的黑话与图片：在这里审、改、导出。')
    + `<div class="toolbar">${seg([{ value: 'stickers', label: '表情包' }, { value: 'slang', label: '黑话' }], assetsState.tab, 'assetsTab')}</div>`
    + assetNotice();
  let data;
  try {
    data = await api(slang ? '/api/slang' : '/api/stickers');
  } catch (error) {
    return head + alertBox('err', '读不到这个库', reason(error));
  }
  if (!data || !data.available) {
    return head + alertBox('warn', '这个功能没有启用', slang
      ? '黑话模块这次没有加载，所以没有可看的内容。'
      : '表情包模块这次没有加载，所以没有可看的内容。');
  }
  return head + (slang ? assetsSlangView(data) : assetsStickersView(data));
};
