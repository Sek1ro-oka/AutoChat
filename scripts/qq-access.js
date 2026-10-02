import { loadConfig } from '../src/config.js';
import { OneBot } from '../src/onebot.js';

const config = loadConfig();
const transport = new OneBot(config);
transport.start();
try {
  const deadline = Date.now() + 12000;
  while (!transport.ready && !transport.stopped && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!transport.ready) throw new Error('ONEBOT_NOT_READY');
  const groups = await transport.call('get_group_list', {});
  const friends = await transport.call('get_friend_list', {});
  const ids = new Set(friends.map(friend => String(friend.user_id)));
  console.log(JSON.stringify({ configuredGroups: config.groupIds.map(id => ({ id,
    botInGroup: groups.some(group => String(group.group_id) === id) })),
    privateUsers: config.privateUsers.map(id => ({ id, isFriend: ids.has(id) })) }));
} catch (error) {
  console.error(['ONEBOT_NOT_READY', 'ONEBOT_ACTION_FAILED', 'ONEBOT_TIMEOUT', 'ONEBOT_DISCONNECTED']
    .includes(error.message) ? error.message : 'QQ_ACCESS_CHECK_FAILED');
  process.exitCode = 1;
} finally { transport.stop(); }
