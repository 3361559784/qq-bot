(async () => {
  const { createScheduleHandler } = require('./services/scheduleService');

  function createMockCosmosContainer(profile) {
    return {
      item: (id, pk) => ({
        read: async () => {
          if (id === profile.id) return { resource: profile };
          const err = new Error('NotFound'); err.statusCode = 404; throw err;
        }
      }),
      items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) }
    };
  }

  const profile = {
    id: `schedule_web_unknown`,
    type: 'schedule_profile',
    userId: 'web_unknown',
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
    fileLinks: [], imageUrls: [], msg: '明天有课吗？', senderId: 'web_unknown', dbKey: 'schedule_web_unknown', cosmosContainer, context: { log: console.log }, token: ''
  });

  console.log('RESP STATUS:', resp.status);
  console.log('RESP BODY:', resp.body);
})();
