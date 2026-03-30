const test = require('node:test');
const assert = require('node:assert/strict');

const { SCENE_SKELETONS, detectSceneKey, selectSceneSkeleton } = require('../src/v2/core/sceneSkeletonRegistry');

test('sceneSkeletonRegistry: has 12 registered scenes', () => {
  const keys = Object.keys(SCENE_SKELETONS);
  assert.equal(keys.length, 12);
  assert.ok(keys.includes('clarification_followup'));
  assert.ok(keys.includes('task_planning'));
  assert.ok(keys.includes('apology_repair'));
  assert.ok(keys.includes('celebration_checkpoint'));
});

test('sceneSkeletonRegistry: detects identity scene by prompt profile', () => {
  const key = detectSceneKey(
    { content: '你是谁？' },
    {
      promptProfileName: 'identity_meta',
      capabilityPlan: { mode: 'chat' }
    }
  );

  assert.equal(key, 'identity_meta');
});

test('sceneSkeletonRegistry: returns null when capability mode is enabled', () => {
  const key = detectSceneKey(
    { content: '帮我画一张图' },
    {
      capabilityPlan: { mode: 'capability' }
    }
  );

  assert.equal(key, null);
});

test('sceneSkeletonRegistry: selects deterministic variant per user and scene', () => {
  const req = { user_id: 'u_scene_1', content: '今天有点难过' };
  const s1 = selectSceneSkeleton(req, {
    capabilityPlan: { mode: 'chat' },
    responsePolicy: { mode: 'brief' },
    historyTurns: [{ role: 'assistant', content: 'x' }]
  });
  const s2 = selectSceneSkeleton(req, {
    capabilityPlan: { mode: 'chat' },
    responsePolicy: { mode: 'brief' },
    historyTurns: [{ role: 'assistant', content: 'x' }]
  });

  assert.equal(Boolean(s1), true);
  assert.equal(s1.variantId, s2.variantId);
  assert.equal(s1.key, 'emotional_support');
});

test('sceneSkeletonRegistry: detects newly added scenes', () => {
  const cases = [
    { text: '对不起我说重了', expected: 'apology_repair' },
    { text: '这事我搞定了，已经通过了', expected: 'celebration_checkpoint' },
    { text: '我没听懂，能不能再解释一遍', expected: 'clarification_followup' },
    { text: '帮我做个计划，把步骤拆解出来', expected: 'task_planning' }
  ];

  for (const c of cases) {
    const key = detectSceneKey(
      { content: c.text },
      {
        capabilityPlan: { mode: 'chat' },
        responsePolicy: { mode: 'brief' }
      }
    );
    assert.equal(key, c.expected);
  }
});
