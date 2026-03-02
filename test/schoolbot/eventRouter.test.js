const test = require('node:test');
const assert = require('node:assert/strict');
const { routeNonChatEvents } = require('../../src/functions/schoolbot/http/eventRouter');

test('routeNonChatEvents: poke disabled on gray tip event', async () => {
  const resp = await routeNonChatEvents({
    body: {
      msg_type: 5,
      sub_msg_type: 12
    },
    selfId: '1',
    context: { log: () => {} },
    arisDisablePoke: true,
    botQqId: '',
    cosmosContainer: null,
    handlePokeLogic: async () => ({ status: 200, jsonBody: { message: 'poke' } }),
    updateLastBotReply: async () => {}
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.jsonBody.message, 'poke_disabled');
});

test('routeNonChatEvents: group increase sends welcome message', async () => {
  let called = false;
  const resp = await routeNonChatEvents({
    body: {
      post_type: 'notice',
      notice_type: 'group_increase',
      user_id: '1002',
      group_id: '5566'
    },
    selfId: '9999',
    context: { log: () => {} },
    arisDisablePoke: false,
    botQqId: '',
    cosmosContainer: {},
    handlePokeLogic: async () => ({ status: 200 }),
    updateLastBotReply: async () => {
      called = true;
    }
  });

  assert.equal(called, true);
  assert.equal(resp.status, 200);
  const payload = JSON.parse(resp.body);
  assert.match(payload.reply, /欢迎新成员加入/);
});
