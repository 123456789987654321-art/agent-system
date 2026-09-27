// Test-process-only transport. Production never imports this fixture.
const axios = require('axios');
const uses = new Map();
axios.post = async (url, body, options) => {
  const key = options?.headers?.Authorization?.replace(/^Bearer /, '');
  const fail = (status, code) => {
    const error = new Error('Upstream secret: ' + key);
    if (status) error.response = { status, data: { error: { message: 'Upstream secret: ' + key } } };
    if (code) error.code = code;
    throw error;
  };
  if (key === 'test-timeout') fail(null, 'ECONNABORTED');
  if (key === 'test-network') fail(null, 'ECONNRESET');
  const statuses = { 'test-expired': 401, 'test-denied': 403, 'test-balance': 402, 'test-rate': 429, 'test-missing-model': 404, 'test-bad-request': 400, 'test-unavailable': 503 };
  if (statuses[key]) fail(statuses[key]);
  if (key === 'test-revoked') {
    uses.set(key, (uses.get(key) || 0) + 1);
    if (uses.get(key) > 1) fail(401);
  } else if (!['test-valid', 'test-malformed', 'test-empty', 'test-actions', 'test-error-envelope'].includes(key)) fail(401);
  if (url !== 'https://api.deepseek.com/chat/completions') fail(401);
  if (body.model !== 'deepseek-chat') fail(404);
  if (key === 'test-empty') return { data: {} };
  if (key === 'test-error-envelope') return { data: { error: { message: 'rejected' } } };
  const plan = { reply: '模型回复', actions: key === 'test-actions' ? [null] : [] };
  return { data: { choices: [{ message: { content: key === 'test-malformed' ? 'not json' : JSON.stringify(plan) } }] } };
};
