function shouldTreatAsDraw(msg, intentResult, intentConfidenceThreshold) {
  const text = String(msg || '');
  const drawRegexTriggered = /(帮我画|画一|画个|画张|画图|绘图|绘制|生成.*图|作画|来一张|画画)/.test(text);
  const forceDraw = !!(intentResult && intentResult.tool === 'draw' && intentResult.confidence >= intentConfidenceThreshold);
  return forceDraw || drawRegexTriggered;
}

function canRunImageAnalysis({ imageUrls, mediaReply, isDrawTaskDone }) {
  return Array.isArray(imageUrls) && imageUrls.length > 0 && !mediaReply && !isDrawTaskDone;
}

module.exports = {
  shouldTreatAsDraw,
  canRunImageAnalysis
};
