export const RULE_REPLY = '我是什么都不会告诉你的';

export function containsTerm(text, terms = []) {
  return findTerm(text, terms) !== undefined;
}

export function findTerm(text, terms = []) {
  const normalized = text.toLowerCase();
  return terms.find(term => normalized.includes(term.toLowerCase()));
}

export function matchesInputRule(text, config) {
  return containsTerm(text, config.blockTerms) || containsTerm(text, config.triggerTerms);
}
