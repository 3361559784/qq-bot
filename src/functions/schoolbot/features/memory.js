function simpleVectorize(text, dimension = 50) {
  const vector = new Array(dimension).fill(0);
  if (!text) return vector;

  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const index = charCode % dimension;
    vector[index] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return magnitude > 0 ? vector.map(v => v / magnitude) : vector;
}

function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  return magnitude > 0 ? dotProduct / magnitude : 0;
}

module.exports = {
  simpleVectorize,
  cosineSimilarity
};
