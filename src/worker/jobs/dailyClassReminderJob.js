const { query, isPgEnabled } = require('../../storage/pg/client');
const { logAudit } = require('../../v2/services/auditService');

function getBeijingWeekday() {
  const now = new Date();
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
  const bj = new Date(utcTime + 8 * 3600000);
  const day = bj.getUTCDay();
  return day === 0 ? 7 : day;
}

function formatClassReminder(courses) {
  if (!Array.isArray(courses) || courses.length === 0) {
    return '(轻松) 今天没有安排课程哦！可以好好休息！✨';
  }

  const sorted = courses
    .slice()
    .sort((a, b) => String(a.timeStart || '').localeCompare(String(b.timeStart || '')));

  const firstClass = sorted[0] || {};
  let msg = '邦邦咔邦！Sensei早安！(✨ω✨)\n\n';
  msg += `📚 今天有 ${sorted.length} 节课哦！\n\n`;
  msg += '第一节课:\n';
  msg += `📖 ${firstClass.name || '课程'}\n`;
  msg += `⏰ ${firstClass.timeStart || '--:--'}-${firstClass.timeEnd || '--:--'}\n`;
  msg += `📍 ${firstClass.location || '位置待确认'}\n`;

  if (sorted.length > 1) {
    msg += '\n还有其他课程:\n';
    for (const c of sorted.slice(1)) {
      msg += `• ${c.timeStart || '--:--'} ${c.name || '课程'}`;
      if (c.location) msg += ` @${c.location}`;
      msg += '\n';
    }
  }

  msg += '\n💪 爱丽丝会一直支援Sensei的！加油哦！';
  return msg;
}

async function sendPrivateMsg(userId, message, context) {
  const base = String(process.env.NAPCAT_API_URL || 'http://127.0.0.1:6009').replace(/\/$/, '');
  const token = String(process.env.NAPCAT_TOKEN || '');

  try {
    const resp = await fetch(`${base}/send_private_msg`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ user_id: userId, message })
    });

    if (!resp.ok) {
      context?.warn?.(`[dailyReminder] send failed user=${userId} code=${resp.status}`);
      return false;
    }

    return true;
  } catch (err) {
    context?.error?.(`[dailyReminder] send exception user=${userId} err=${err.message}`);
    return false;
  }
}

async function loadScheduleProfiles() {
  if (!isPgEnabled(process.env)) return [];

  const sql = `
    SELECT data
    FROM documents
    WHERE (data->>'type' = 'schedule_profile' OR data->>'kind' = 'schedule_profile')
      OR (store_name = 'memory' AND data ? 'weekly_schedule')
    ORDER BY updated_at DESC
    LIMIT 5000
  `;

  const res = await query(sql, []);
  return res.rows.map((r) => r.data).filter(Boolean);
}

async function runDailyClassReminderJob(context = null) {
  const weekday = getBeijingWeekday();
  const profiles = await loadScheduleProfiles();

  let success = 0;
  let failed = 0;

  for (const p of profiles) {
    const userId = String(p.userId || p.user_id || p.senderId || '').trim();
    if (!userId) continue;

    const schedule = Array.isArray(p.weekly_schedule) ? p.weekly_schedule : [];
    const courses = schedule.filter((x) => Number(x.day || x.weekday) === weekday);
    const msg = formatClassReminder(courses);

    // eslint-disable-next-line no-await-in-loop
    const ok = await sendPrivateMsg(userId, msg, context);
    if (ok) success += 1;
    else failed += 1;
  }

  await logAudit('worker.daily_class_reminder.executed', {
    request_id: `daily_${Date.now()}`,
    success,
    failed,
    total_profiles: profiles.length,
    weekday
  }, context);

  return { success, failed, total: profiles.length, weekday };
}

module.exports = {
  runDailyClassReminderJob
};
