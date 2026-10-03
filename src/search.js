export function searchQuery(text) {
  const match = text.match(/^(?:\/(?:搜索|联网搜索)(?:\s+|[：:]|$)|(?:请|帮我)?联网搜索[\s：:]*|(?:请|帮我)?搜索(?:\s+|[：:]|$))(.*)$/u);
  return match ? match[1].trim() : null;
}

// Opt-in deterministic routing. Only the current question goes to search, never history.
export function autoSearchQuery(text) {
  if (!text || text.startsWith('/')) return null;
  return /天气|气温|天气预报|新闻|热搜|实时|最新|(?:今天|今日|明天|目前|现在|最近|近期).{0,20}(?:价格|报价|汇率|股价|版本|动态|消息|资讯|赛程|比分|结果)|(?:价格|报价|汇率|股价|版本|动态|消息|资讯|赛程|比分).{0,20}(?:今天|今日|目前|现在|最近|近期)/u.test(text)
    ? text : null;
}

export function searchSources(blocks) {
  const sources = [], seen = new Set();
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const item of block.content) {
      if (item.type !== 'web_search_result' || typeof item.url !== 'string') continue;
      let url;
      try { url = new URL(item.url); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || url.href.length > 500 || seen.has(url.href)) continue;
      seen.add(url.href);
      sources.push({ url: url.href, title: typeof item.title === 'string' ? item.title.replace(/[\r\n]/g, ' ').slice(0, 80) : '搜索来源' });
      if (sources.length === 3) return sources;
    }
  }
  return sources;
}

export function searchUsage(raw) {
  if (!raw) return undefined;
  const input = [raw.input_tokens, raw.cache_creation_input_tokens ?? 0, raw.cache_read_input_tokens ?? 0];
  if (!input.every(value => Number.isSafeInteger(value) && value >= 0)) return undefined;
  return { prompt_tokens: input.reduce((sum, value) => sum + value, 0), completion_tokens: raw.output_tokens };
}
