const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  baseURL: process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai',
  apiKey: process.env.POLSIA_API_KEY,
});

/**
 * Simple chat - Polsia handles model selection
 * @param {string} message - User message
 * @param {object} options - { system, maxTokens, subscriptionId }
 */
async function chat(message, options = {}) {
  const response = await anthropic.messages.create({
    max_tokens: options.maxTokens || 8192,
    messages: [{ role: 'user', content: message }],
    system: options.system,
  }, {
    headers: options.subscriptionId ? { 'X-Subscription-ID': options.subscriptionId } : {}
  });
  return response.content[0].text;
}

module.exports = { anthropic, chat };
