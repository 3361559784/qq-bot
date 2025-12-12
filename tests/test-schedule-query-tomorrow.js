// 本地快速回归：验证“明天有课吗”会走课表查询分支（无需真实 Cosmos）
const assert = require('assert');
const { createScheduleHandler } = require('../services/scheduleService');

function createMockCosmosContainer(profile) {
  return {
    item: (id, pk) => ({
      read: async () => {
        // 仅在正确 id 时返回，pk 不强校验（真实逻辑里会尝试多种 pk）
        if (id === profile.id) return { resource: profile };
        const err = new Error('NotFound');
        err.statusCode = 404;
        throw err;
      }
    }),
    items: {
      query: () => ({
        fetchAll: async () => ({ resources: [] })
      })
    }
  };
}

async function main() {
  const userId = 'web_unknown';
  const profile = {
    id: `schedule_${userId}`,
    type: 'schedule_profile',
    userId,
    weekly_schedule: [
      { day: 1, start: 1, name: '高等数学', timeStart: '08:00', timeEnd: '09:40', location: 'A101' },
      { day: 1, start: 3, name: '英语', timeStart: '10:10', timeEnd: '11:50', location: 'B203' }
    ],
    schedule_config: { last_updated: new Date().toISOString() }
  };

  const cosmosContainer = createMockCosmosContainer(profile);

  const handler = createScheduleHandler({
    fetchBypass: async () => null,
    checkComputerVision: async () => null,
    updateLastBotReply: async () => null
  });

  const resp = await handler({
    fileLinks: [],
    imageUrls: [],
    msg: '明天有课吗？',
    senderId: userId,
    dbKey: userId,
    cosmosContainer,
    context: { log: () => {} },
    token: ''
  });

  assert(resp && resp.status === 200, 'should return http 200');
  const body = JSON.parse(resp.body);
  assert(typeof body.reply === 'string' && body.reply.length > 0, 'should have reply string');
  assert(body.reply.includes('明天') || body.reply.includes('今天'), 'reply should mention day');

  console.log('OK: schedule query returns a reply:', body.reply.split('\n')[0]);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
