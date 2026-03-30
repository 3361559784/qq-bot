const { detectAdvancedEmotion } = require('../../../services/emotionService');

const POSITIVE_RESPONSES = new Set(['happy', 'gentle', 'caring', 'playful']);
const NEGATIVE_TYPES = new Set(['PANIC', 'RUDE']);

const FORMAL_PATTERNS = /(您好|请问|麻烦|烦请|请您|可否|敬请)/i;
const PLAYFUL_PATTERNS = /(哈哈|嘿嘿|~|～|ww|233|诶|呀|哇)/i;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function safeDateMs(value, fallbackMs = Date.now()) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return fallbackMs;
  return ms;
}

function getRecentTurns(turns = [], role = 'user', window = 10) {
  return (Array.isArray(turns) ? turns : [])
    .filter((x) => String(x?.role || '').toLowerCase() === role)
    .slice(-Math.max(1, window));
}

function scoreEmotionType(type = 'NEUTRAL') {
  const map = {
    PRAISED: 2.0,
    CASUAL_CHAT: 1.0,
    HELP_REQUEST: 0.6,
    SAD: -0.2,
    TIRED: -0.3,
    TEASED: -0.6,
    RUDE: -2.0,
    PANIC: -3.0,
    NEUTRAL: 0
  };
  return map[String(type || 'NEUTRAL').toUpperCase()] || 0;
}

function detectTurnEmotion(turn = {}) {
  const metadataEmotion = turn?.metadata?.emotion;
  if (metadataEmotion?.type || metadataEmotion?.response) {
    return {
      type: metadataEmotion.type || 'NEUTRAL',
      response: metadataEmotion.response || 'normal'
    };
  }

  const fallback = detectAdvancedEmotion(String(turn?.content || ''));
  return {
    type: fallback?.type || 'NEUTRAL',
    response: fallback?.response || 'normal'
  };
}

function deriveSentimentTrend(scores = []) {
  if (!Array.isArray(scores) || scores.length < 4) return 'stable';

  const mid = Math.floor(scores.length / 2);
  const first = scores.slice(0, mid);
  const second = scores.slice(mid);

  const avg = (arr) => {
    if (!arr.length) return 0;
    return arr.reduce((sum, x) => sum + x, 0) / arr.length;
  };

  const delta = avg(second) - avg(first);
  if (delta > 0.35) return 'improving';
  if (delta < -0.35) return 'declining';
  return 'stable';
}

function deriveEngagementLevel(lastInteractionMinutesAgo = 0, frequencyPerDay = 0) {
  if (lastInteractionMinutesAgo > 24 * 60) return 'idle';
  if (frequencyPerDay >= 1 && lastInteractionMinutesAgo <= 120) return 'high';
  if (frequencyPerDay >= 0.45 && lastInteractionMinutesAgo <= 8 * 60) return 'medium';
  return 'low';
}

function deriveMicroState({
  engagementLevel = 'low',
  sentimentTrend = 'stable',
  hasRecentPanicOrRude = false,
  idleWarning = false
} = {}) {
  if (idleWarning || engagementLevel === 'idle') return 'distant';
  if (hasRecentPanicOrRude || sentimentTrend === 'declining') return 'cooling_off';
  if (engagementLevel === 'high' && sentimentTrend !== 'declining') return 'invested';
  if (sentimentTrend === 'improving') return 'warming_up';
  return 'awake';
}

function classifyCommunicationStyle(text = '') {
  const content = String(text || '').trim();
  const len = content.length;

  if (!content) return 'concise';
  if (FORMAL_PATTERNS.test(content)) return 'formal';
  if (PLAYFUL_PATTERNS.test(content)) return 'playful';
  if (len >= 70) return 'verbose';
  return 'concise';
}

function inferInteractionType({
  requestContent = '',
  currentEmotionType = 'NEUTRAL',
  capabilityMode = 'chat',
  responsePolicyMode = 'brief'
} = {}) {
  if (capabilityMode === 'capability') return 'tool_request';

  const text = String(requestContent || '').trim();
  if (!text) return 'unclear';

  if (['SAD', 'TIRED', 'PANIC'].includes(String(currentEmotionType || '').toUpperCase())) {
    return 'seeking_comfort';
  }

  if (responsePolicyMode === 'professional' || /怎么|如何|原理|推导|代码|数学|证明|调试/i.test(text)) {
    return 'seeking_help';
  }

  if (/在吗|聊聊|无聊|哈哈|最近|今天怎么样/i.test(text)) {
    return 'casual_chat';
  }

  return 'unclear';
}

function computeRelationshipDeltaState({
  turns = [],
  requestContent = '',
  currentEmotion = {},
  capabilityMode = 'chat',
  responsePolicyMode = 'brief',
  effectiveSafety = { action: 'pass' },
  nowTs = Date.now()
} = {}) {
  const allTurns = Array.isArray(turns) ? turns : [];
  const userTurns = getRecentTurns(allTurns, 'user', 30);
  const recentUserTurns = userTurns.slice(-10);
  const recentForRisk = userTurns.slice(-5);

  const lastTurnMs = allTurns.length
    ? safeDateMs(allTurns[allTurns.length - 1]?.created_at, nowTs)
    : nowTs;
  const lastInteractionMinutesAgo = Math.max(0, (nowTs - lastTurnMs) / 60000);

  const sevenDaysAgoMs = nowTs - 7 * 24 * 3600 * 1000;
  const last7DaysTurns = allTurns.filter((x) => safeDateMs(x?.created_at, 0) >= sevenDaysAgoMs);
  const interactionFrequencyPerDay = Number((last7DaysTurns.length / 7).toFixed(3));

  const emotionSnapshots = recentUserTurns.map((turn) => detectTurnEmotion(turn));
  const sentimentScores = emotionSnapshots.map((x) => scoreEmotionType(x.type));

  const positiveCount = emotionSnapshots.filter((x) => POSITIVE_RESPONSES.has(String(x.response || ''))).length;
  const recentPositiveRatio = recentUserTurns.length
    ? Number((positiveCount / recentUserTurns.length).toFixed(3))
    : 0;

  const hasRecentPanicOrRude = recentForRisk.some((turn) => {
    const e = detectTurnEmotion(turn);
    return NEGATIVE_TYPES.has(String(e.type || '').toUpperCase());
  });

  const lastPositiveTurn = [...recentUserTurns].reverse().find((turn) => {
    const e = detectTurnEmotion(turn);
    return POSITIVE_RESPONSES.has(String(e.response || ''));
  });

  const lastPositiveInteractionMinutesAgo = lastPositiveTurn
    ? Math.max(0, (nowTs - safeDateMs(lastPositiveTurn.created_at, nowTs)) / 60000)
    : null;

  const sentimentTrend = deriveSentimentTrend(sentimentScores);
  const engagementLevel = deriveEngagementLevel(lastInteractionMinutesAgo, interactionFrequencyPerDay);
  const idleWarning = lastInteractionMinutesAgo > 24 * 60;

  const currentMicroState = deriveMicroState({
    engagementLevel,
    sentimentTrend,
    hasRecentPanicOrRude,
    idleWarning
  });

  const interactionType = inferInteractionType({
    requestContent,
    currentEmotionType: currentEmotion?.type || 'NEUTRAL',
    capabilityMode,
    responsePolicyMode
  });

  let stateConfidence = 0.35 + Math.min(0.5, recentUserTurns.length * 0.06);
  if (hasRecentPanicOrRude) stateConfidence -= 0.1;
  if (String(effectiveSafety?.action || 'pass') !== 'pass') stateConfidence -= 0.1;
  stateConfidence = Number(clampNumber(stateConfidence, 0.1, 1).toFixed(3));

  const shouldDegradeDueToSafety = String(effectiveSafety?.action || 'pass') !== 'pass';
  const shouldAmplifyAffection = !shouldDegradeDueToSafety
    && !hasRecentPanicOrRude
    && recentPositiveRatio >= 0.35
    && ['high', 'medium'].includes(engagementLevel);

  return {
    lastInteractionMinutesAgo: Number(lastInteractionMinutesAgo.toFixed(2)),
    lastPositiveInteractionMinutesAgo: Number.isFinite(lastPositiveInteractionMinutesAgo)
      ? Number(lastPositiveInteractionMinutesAgo.toFixed(2))
      : null,
    interactionFrequencyPerDay,
    engagementLevel,
    recentPositiveRatio,
    hasRecentPanicOrRude,
    sentimentTrend,
    interactionType,
    userCommunicationStyle: classifyCommunicationStyle(requestContent),
    currentMicroState,
    stateConfidence,
    shouldAmplifyAffection,
    shouldDegradeDueToSafety,
    idleWarning
  };
}

module.exports = {
  computeRelationshipDeltaState,
  deriveEngagementLevel,
  deriveMicroState,
  classifyCommunicationStyle,
  inferInteractionType
};
