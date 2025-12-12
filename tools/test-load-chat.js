const fetch = require('node-fetch');

(async () => {
  const url = 'http://localhost:3000/api/chat';
  const results = [];
  for (let i = 0; i < 30; i++) {
    const message = `loadtest ${i}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId: `sid_loadtest_${i}` }),
        timeout: 15000
      });
      const text = await res.text();
      results.push({ i, status: res.status, body: text });
    } catch (err) {
      results.push({ i, status: 'error', error: err.message });
    }
    // short delay
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(JSON.stringify(results, null, 2));
})();