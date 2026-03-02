const handler = require('./http/handler');

module.exports = {
  handleScheduleRequest: handler.handleScheduleRequest,
  getCosmosContainer: handler.getCosmosContainer,
  getGithubToken: handler.getGithubToken,
  aiPostProcess: handler.aiPostProcess,
  detectLanguage: handler.detectLanguage,
  getPromptByLanguage: handler.getPromptByLanguage,
  simpleVectorize: handler.simpleVectorize,
  cosineSimilarity: handler.cosineSimilarity
};
