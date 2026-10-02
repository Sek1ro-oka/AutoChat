// UTF-8 byte count is a deliberately conservative proxy, not a tokenizer guarantee.
export function estimateInput(messages) {
  return 256 + messages.reduce((total, item) => total + Buffer.byteLength(item.content, 'utf8') + 64, 0);
}
export function costMicro(inputTokens, outputTokens, config) {
  return Math.ceil(inputTokens * config.inputPrice + outputTokens * config.outputPrice);
}
export function prepareMessages(history, text, config) {
  const previous = [...history];
  const make = () => [{ role: 'system', content: config.systemPrompt }, ...previous, { role: 'user', content: text }];
  while (previous.length && estimateInput(make()) > config.contextTokens) previous.splice(0, 2);
  if (estimateInput(make()) > config.contextTokens) throw new Error('INPUT_TOO_LONG');
  return make();
}
export function usageCost(usage, config) {
  if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0
      || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0) return null;
  // Charge all input at the uncached price; discounts never weaken the cap.
  return costMicro(usage.prompt_tokens, usage.completion_tokens, config);
}
export class Model {
  constructor(config) { this.config = config; }
  async complete(messages) {
    const config = this.config;
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, max_tokens: config.maxOutput,
        stream: false, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error',
    });
    if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
    const body = await response.json();
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { text: null, usage: body.usage };
    }
    return { text: content.trim(), usage: body.usage };
  }
}
