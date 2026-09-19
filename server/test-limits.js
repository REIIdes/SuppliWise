// Check rate limits for each model by looking at response headers
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const key = process.env.GROQ_API_KEY;
const models = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];

async function checkModel(model) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    }),
  });
  const tpmLimit = res.headers.get('x-ratelimit-limit-tokens') || 'unknown';
  const tpmRemaining = res.headers.get('x-ratelimit-remaining-tokens') || 'unknown';
  console.log(`${model}: TPM limit=${tpmLimit}, remaining=${tpmRemaining}, status=${res.status}`);
}

(async () => {
  for (const m of models) await checkModel(m);
})();
