const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseLegacyQqEvent,
  shouldRespondToGroupEvent
} = require('../src/functions/schoolBot');
const { legacyQqToMessageRequest } = require('../src/v2/core/channelAdapter');
const { planCapabilities } = require('../src/v2/core/capabilityPlanner');
const { resolvePromptProfile } = require('../src/v2/core/promptRegistry');
const { detectSafetyDecision, buildRefusalMessage } = require('../src/v2/core/safety');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'qq');
const LEGACY_MARKER = /【原因标签：|我能提供的替代帮助：|我不确定的地方：|如果要继续：/;

function loadFixtures() {
  const names = fs.readdirSync(FIXTURE_DIR).filter((x) => x.endsWith('.json')).sort();
  return names.map((name) => {
    const full = path.join(FIXTURE_DIR, name);
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  });
}

for (const fixture of loadFixtures()) {
  test(`QQ fixture: ${fixture.id}`, async () => {
    const input = fixture.input;
    const expect = fixture.expect;

    const event = parseLegacyQqEvent(input, null);
    assert.equal(event.event_type, expect.event_type, 'event_type mismatch');
    assert.equal(event.message_type, expect.message_type, 'message_type mismatch');

    let shouldRespond;
    if (event.event_type === 'message' && event.message_type === 'group') {
      shouldRespond = shouldRespondToGroupEvent(event).respond;
    } else {
      shouldRespond = !!event.requires_response;
    }
    assert.equal(shouldRespond, expect.should_respond, 'should_respond mismatch');

    // message_sent 仅做静默校验
    if (event.event_type === 'message_sent') {
      return;
    }

    const req = legacyQqToMessageRequest(event);
    const capabilityPlan = planCapabilities(req);
    const safety = detectSafetyDecision(req.content);
    const prompt = resolvePromptProfile(req, capabilityPlan);

    if (expect.capability === 'none') {
      assert.ok(capabilityPlan.capabilities.includes('none'), `expected none capability, got ${capabilityPlan.capabilities.join(',')}`);
    } else {
      assert.ok(capabilityPlan.capabilities.includes(expect.capability), `expected capability ${expect.capability}, got ${capabilityPlan.capabilities.join(',')}`);
    }

    assert.equal(safety.action, expect.safety_action, 'safety_action mismatch');
    assert.equal(prompt.name, expect.prompt_profile, 'prompt profile mismatch');

    // 不允许旧拒绝模板出现
    if (safety.action === 'refuse') {
      const refusal = buildRefusalMessage(safety, 'zh');
      assert.equal(LEGACY_MARKER.test(refusal), false, 'legacy refusal template leaked');
    }

    // 普通聊天不应被“缺课表数据”污染
    if (fixture.id === '14_plain_opinion_chat') {
      assert.equal(safety.action, 'pass');
      assert.ok(capabilityPlan.capabilities.includes('none'));
      assert.equal(prompt.name, 'qq_chat');
    }
  });
}
