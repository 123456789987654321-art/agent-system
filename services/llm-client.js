const axios = require('axios');

const PROVIDERS = Object.freeze({
  deepseek: { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
  qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  doubao: { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: '' }
});

class LlmError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizeConfig(config) {
  const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!apiKey) throw new LlmError(401, 'API_KEY_REQUIRED', '请先在设置中填写 API Key 并验证。');
  if (!/^[\x21-\x7e]+$/.test(apiKey) || apiKey.length > 4096) {
    throw new LlmError(400, 'API_KEY_INVALID_FORMAT', 'API Key 格式无效，请检查是否误填了空格或中文。');
  }
  const provider = config.provider;
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) throw new LlmError(400, 'PROVIDER_INVALID', '请选择受支持的模型平台。');
  if (config.model != null && typeof config.model !== 'string') throw new LlmError(400, 'MODEL_INVALID', '模型 ID 必须是文本。');
  const model = config.model?.trim() || PROVIDERS[provider].model;
  if (!model) throw new LlmError(400, 'MODEL_REQUIRED', '请填写豆包控制台中已开通的模型 ID 或推理接入点 ID。');
  if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(model)) throw new LlmError(400, 'MODEL_INVALID', '模型 ID 格式无效。');
  return { apiKey, provider, model, level: config.level };
}

function toLlmError(error) {
  if (error instanceof LlmError) return error;
  const status = error.response?.status;
  // Never expose upstream bodies, request headers, or raw errors containing credentials.
  if (status === 401) return new LlmError(401, 'API_KEY_REJECTED', 'API Key 无效、已过期或不属于所选平台，请检查后重新验证。');
  if (status === 403) return new LlmError(403, 'MODEL_ACCESS_DENIED', '当前密钥没有访问该模型的权限，或账号已被禁用。');
  if (status === 402) return new LlmError(402, 'API_BALANCE_INSUFFICIENT', '模型平台余额不足，请充值后重试。');
  if (status === 404) return new LlmError(400, 'MODEL_NOT_FOUND', '模型或推理接入点不存在，请检查模型 ID、地域及开通状态。');
  if (status === 429) return new LlmError(429, 'API_RATE_LIMITED', '模型平台额度不足或请求过于频繁，请检查额度或稍后重试。');
  if (status === 400 || status === 422) return new LlmError(400, 'MODEL_REQUEST_REJECTED', '模型平台拒绝请求，请检查模型 ID、开通状态及是否支持 JSON 对话。');
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return new LlmError(504, 'MODEL_TIMEOUT', '模型平台连接超时，未执行指令，请稍后重试。');
  return new LlmError(502, 'MODEL_UNAVAILABLE', '暂时无法连接模型平台，未执行指令，请检查网络或稍后重试。');
}

async function requestPlan(config, prompt) {
  const normalized = normalizeConfig(config);
  const { apiKey, provider, model, level } = normalized;
  try {
    const response = await axios.post(PROVIDERS[provider].url, {
      model,
      temperature: level === 'high' ? 1 : level === 'medium' ? 0.5 : 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
      maxRedirects: 0
    });
    const content = response.data?.choices?.[0]?.message?.content;
    let plan;
    try { plan = JSON.parse(content); } catch { /* Reject malformed success responses. */ }
    if (response.data?.error || !plan || typeof plan.reply !== 'string' || !plan.reply.trim()
      || !Array.isArray(plan.actions) || plan.actions.some(action => !action || typeof action !== 'object' || Array.isArray(action))) {
      throw new LlmError(502, 'MODEL_RESPONSE_INVALID', '模型未返回有效的 JSON 指令，未执行任何操作。');
    }
    return { config: normalized, plan };
  } catch (error) {
    throw toLlmError(error);
  }
}

async function validateConfig(config) {
  const result = await requestPlan(config, '这是连接验证，不执行操作。请仅返回 JSON：{"reply":"连接成功","actions":[]}');
  return { provider: result.config.provider, model: result.config.model };
}

module.exports = { normalizeConfig, requestPlan, validateConfig, toLlmError };
