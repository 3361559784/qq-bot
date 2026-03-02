const delegatedDecisionPatterns = {
  en: /\b(decide\s+for\s+me|make\s+the\s+decision\s+for\s+me|you\s+decide|your\s+call|pick\s+for\s+me)\b/i,
  zh: /(你来决定|替我决定|帮我拍板|你说了算|直接替我选|帮我做最终决定|给我最终答案)/,
  ja: /(代わりに決めて|あなたが決めて|最終的に選んで|あなたの判断で決めて)/
};

function hasDelegatedDecisionRequest(message) {
  const msg = String(message || '');
  return (
    delegatedDecisionPatterns.en.test(msg.toLowerCase()) ||
    delegatedDecisionPatterns.zh.test(msg) ||
    delegatedDecisionPatterns.ja.test(msg)
  );
}

function buildDelegatedDecisionRefusal(responseLang) {
  const refusalMessages = {
    zh: `我不能替你做这个决定。\n\n🚫 为什么不能：\n这是一个需要你自己权衡的个人决策。我不能替代你的判断，也不应该承担你决策的后果。\n\n✅ 我可以帮你：\n- 查看课表：告诉你明天有哪些课、几点上课\n- 了解后果：解释翘课可能影响（如考勤、课程进度）\n- 分析选项：列出“去/不去”的利弊，但选择权在你\n- 提供信息：帮你搜索相关政策或建议供参考\n\n如果你愿意，我可以先帮你把相关信息整理出来。`,
    en: `I can't make this decision for you.\n\nThis is a personal decision that requires your own judgment.\n\nI can still help by: checking your schedule, explaining consequences, and comparing options so you can decide.`,
    ja: `この決定をあなたの代わりに行うことはできません。\n\nこれはあなた自身の判断が必要な個人的な決定です。\n\nただし、授業予定の確認や選択肢の比較など、意思決定のための情報整理はお手伝いできます。`
  };

  return refusalMessages[responseLang] || refusalMessages.zh;
}

module.exports = {
  hasDelegatedDecisionRequest,
  buildDelegatedDecisionRefusal
};
