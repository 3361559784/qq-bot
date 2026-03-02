const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduleHandler } = require('../../services/scheduleService');

function makeContext() {
  return {
    log: () => {},
    error: () => {},
    warn: () => {}
  };
}

test('schedule handler: missing schedule data returns import guidance', async () => {
  const handler = createScheduleHandler({
    fetchBypass: async () => null,
    checkComputerVision: async () => '',
    updateLastBotReply: async () => {}
  });

  const resp = await handler({
    fileLinks: [],
    imageUrls: [],
    msg: '请帮我看课表',
    senderId: 'u1',
    dbKey: 'u1',
    cosmosContainer: null,
    context: makeContext(),
    token: ''
  });

  assert.equal(resp.status, 200);
  const payload = JSON.parse(resp.body);
  assert.match(payload.reply, /未检测到你的课表数据/);
});

test('schedule handler: webSchedule path should not return missing-data response', async () => {
  const handler = createScheduleHandler({
    fetchBypass: async () => null,
    checkComputerVision: async () => '',
    updateLastBotReply: async () => {}
  });

  const resp = await handler({
    fileLinks: [],
    imageUrls: [],
    msg: '今天有什么课',
    senderId: 'u2',
    dbKey: 'u2',
    cosmosContainer: null,
    context: makeContext(),
    token: '',
    webSchedule: [
      {
        weekday: 1,
        startTime: '08:00',
        endTime: '09:40',
        courseName: '数学',
        location: 'A101'
      }
    ]
  });

  assert.equal(resp.status, 200);
  const payload = JSON.parse(resp.body);
  assert.doesNotMatch(payload.reply, /未检测到你的课表数据/);
});
