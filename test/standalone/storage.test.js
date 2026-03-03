const test = require('node:test');
const assert = require('node:assert/strict');
const { upsertDoc, readDoc, listDocs, deleteDoc } = require('../../src/v2/services/storage');

test('storage fallback memory mode CRUD works when DATABASE_URL absent', async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const doc = { id: 't1', value: 'hello' };
  await upsertDoc('tasks', 'tasks:global', doc);

  const got = await readDoc('tasks', 't1', 'tasks:global');
  assert.equal(got.value, 'hello');

  const list = await listDocs('tasks', 'tasks:global', { limit: 10 });
  assert.equal(Array.isArray(list), true);
  assert.ok(list.some((x) => x.id === 't1'));

  const removed = await deleteDoc('tasks', 't1', 'tasks:global');
  assert.equal(removed, true);

  if (prev !== undefined) process.env.DATABASE_URL = prev;
});
