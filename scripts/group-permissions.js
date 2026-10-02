import { loadConfig } from '../src/config.js';
import { OneBot } from '../src/onebot.js';

const config = loadConfig(), transport = new OneBot(config);
transport.start();
try {
  const deadline = Date.now() + 12000;
  while (!transport.ready && !transport.stopped && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!transport.ready) throw new Error('ONEBOT_NOT_READY');
  const groups = [];
  for (const group of config.groupIds) {
    const member = await transport.call('get_group_member_info', {
      group_id: Number(group), user_id: Number(config.botId), no_cache: true,
    });
    if (String(member.group_id) !== group || String(member.user_id) !== config.botId
        || !['owner', 'admin', 'member'].includes(member.role)) throw new Error('INVALID_MEMBER_INFO');
    groups.push({ group, botRole: member.role, canManage: ['owner', 'admin'].includes(member.role) });
  }
  console.log(JSON.stringify({ enabled: config.groupManagementEnabled, controller: config.groupManagerId, groups }));
} catch {
  console.error('群管理权限只读检查失败；未执行任何群管理操作。');
  process.exitCode = 1;
} finally { transport.stop(); }
