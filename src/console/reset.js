// 「一键重置配置」的服务端实现：设置页底部危险区那一个按钮。
//
// 删的是「配置 + 运行状态 + 学习数据」，不是数据本身：人格卡、聊天记录、账本、
// 说说、事件与群登记都不在这里。`active_persona` / `group_persona:<群>` 也刻意
// 留着 —— 重置参数不该把用户挑好的角色一起抹掉，否则点一次就得重新挑一遍。
//
// 全部动作包在一个事务里：删到一半断掉时宁可什么都没删，也不要留下「参数清了、
// 词库还在」的半截状态。store.bump() 自己会开事务（BEGIN 不能嵌套），这里不用它。
//
// 表情的图片文件在 data/stickers/ 下，这里只删库里的行、不碰磁盘，所以返回的
// `stickers` 是「清掉的行数」，不是「删掉的图片数」—— 界面与 docs 都这么写。

// settings 里整片清掉的命名空间。`social_` / `group_social_` 已经盖住了
// `social_count:` / `social_mute:` / `group_social_*`，仍然逐个列出：它们是
// 不同用途的键，将来前缀被收窄时不会悄悄漏掉某一类。
const RESET_PREFIXES = [
  'cfg:', 'social_', 'group_social_', 'slang_', 'group_slang_', 'sticker_', 'qzone:',
  'search_count:', 'overrun:', 'social_count:', 'social_mute:', 'poke_count:', 'anti_spam_cooldown:',
];

// 精确键：运行状态（开关与熔断原因）与模型档位。`active_persona` 不在这里。
const RESET_KEYS = ['enabled', 'enabled_reason', 'groupEnabled', 'groupEnabled_reason', 'active_model'];

export function resetAll({ store }) {
  return store.transaction(() => {
    // 先收集再删除：删的过程中改不了同一个游标的读取结果，也让计数不会被
    // `social_count:` 这类被上层前缀包含的键重复累加（Set 天然去重）。
    const keys = new Set(RESET_KEYS);
    for (const prefix of RESET_PREFIXES) {
      for (const key of store.settingKeys(prefix)) keys.add(key);
    }
    let settings = 0;
    for (const key of keys) settings += store.remove(key);
    const slang = Number(store.db.prepare('DELETE FROM slang').run().changes);
    const slangGroups = Number(store.db.prepare('DELETE FROM slang_groups').run().changes);
    const stickers = Number(store.db.prepare('DELETE FROM stickers').run().changes);
    return { settings, slang, slangGroups, stickers };
  });
}
