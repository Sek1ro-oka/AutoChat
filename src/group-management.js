export const GROUP_MANAGEMENT_HELP = '群管理命令（仅指定用户私聊）：\n/禁言 群号 成员QQ 分钟\n/解除禁言 群号 成员QQ\n仅限白名单群的普通成员；机器人需群主或管理员权限。禁言时长为1～43200整数分钟。';

export function isGroupManagementCommand(text) {
  return /^\/(禁言|解除禁言|群管理帮助)(?:\s|$)/u.test(text);
}

const validId = text => /^[1-9]\d{4,14}$/.test(text || '') && Number.isSafeInteger(Number(text));
const validMember = (info, group, user) => info && String(info.group_id) === group
  && String(info.user_id) === user && ['member', 'admin', 'owner'].includes(info.role);

export async function manageGroup(message, config, call, alive, log = () => {}) {
  if (message.group || message.user !== config.groupManagerId) return '群管理命令仅限配置的 PRIVATE_USER_QQ 私聊使用。';
  if (!config.groupManagementEnabled) return '群管理功能已关闭；在 .env 设置 GROUP_MANAGEMENT_ENABLED=true 后重启。';
  const parts = message.text.split(/\s+/u);
  if (parts[0] === '/群管理帮助') return GROUP_MANAGEMENT_HELP;
  const unban = parts[0] === '/解除禁言';
  const [, group, user, minutes] = parts;
  if (parts.length !== (unban ? 3 : 4) || !validId(group) || !validId(user)
      || (!unban && (!/^\d+$/.test(minutes || '') || Number(minutes) < 1 || Number(minutes) > 43200))) {
    return GROUP_MANAGEMENT_HELP;
  }
  if (!(config.groupIds ?? [config.groupId]).includes(group)) return '该群不在群白名单中，未执行操作。';
  if (user === config.botId) return '不能对机器人自身执行禁言操作。';
  let submitted = false;
  try {
    if (!alive()) return null;
    const bot = await call('get_group_member_info', { group_id: Number(group), user_id: Number(config.botId), no_cache: true });
    if (!validMember(bot, group, config.botId) || !['admin', 'owner'].includes(bot.role)) {
      return '机器人没有该群的管理员／群主权限，未执行操作。';
    }
    if (!alive()) return null;
    const target = await call('get_group_member_info', { group_id: Number(group), user_id: Number(user), no_cache: true });
    if (!validMember(target, group, user)) return '无法核实目标成员身份，未执行操作。';
    if (target.role !== 'member') return '仅支持对普通群成员操作，不对群主或管理员执行禁言。';
    if (!alive()) return null;
    submitted = true;
    await call('set_group_ban', { group_id: Number(group), user_id: Number(user), duration: unban ? 0 : Number(minutes) * 60 });
    log('group_management_succeeded');
    return unban ? `已解除群 ${group} 中成员 ${user} 的禁言。` : `已将群 ${group} 中成员 ${user} 禁言 ${Number(minutes)} 分钟。`;
  } catch (error) {
    log('group_management_failed');
    if (!submitted) return '群权限或成员信息检查失败，未发送禁言操作。';
    if (error.message === 'ONEBOT_ACTION_FAILED') return '群管理接口拒绝了操作；请检查当前权限及成员状态，未自动重试。';
    return '群管理操作结果未知，请在 QQ 中核实；未自动重试。';
  }
}
