const assert = require('assert');

const { formatScheduleSummary } = require('../services/scheduleService');

function run() {
  const cases = [
    {
      name: 'string datetime',
      events: [
        {
          title: '数学',
          start: '2025-12-12 08:00',
          end: '2025-12-12 09:40',
          location: 'A101'
        }
      ]
    },
    {
      name: 'timestamp ms',
      events: [
        {
          title: '英语',
          start: Date.now() + 60_000,
          end: Date.now() + 3_600_000,
          location: 'B201'
        }
      ]
    },
    {
      name: 'chaoxing object dateTime/date/time',
      events: [
        {
          summary: '程序设计',
          start: { dateTime: '2025-12-12 10:00', date: '2025-12-12', time: '10:00' },
          end: { dateTime: '2025-12-12 11:40', date: '2025-12-12', time: '11:40' },
          location: 'C301'
        }
      ]
    }
  ];

  for (const c of cases) {
    const summary = formatScheduleSummary(c.events, 5);
    assert.strictEqual(typeof summary, 'string', `${c.name}: summary should be string`);
  }

  console.log('OK: scheduleService date coercion does not crash.');
}

try {
  run();
} catch (err) {
  console.error('FAILED:', err);
  process.exit(1);
}
