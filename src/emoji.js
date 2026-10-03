// Common QQ face IDs, verified against NapCatQQ v4.18.28's bundled qface metadata.
// These are protocol identifier/name facts, not copied runtime code or image assets.
const FACE_NAMES = new Map(Object.entries({
  0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
  8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑',
  15: '难过', 16: '酷', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱', 22: '白眼',
  23: '傲慢', 24: '饥饿', 25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑', 29: '悠闲',
  30: '奋斗', 31: '咒骂', 32: '疑问', 33: '嘘', 34: '晕', 35: '折磨', 36: '衰',
  37: '骷髅', 38: '敲打', 39: '再见', 41: '发抖', 42: '爱情', 43: '跳跳',
  46: '猪头', 49: '拥抱', 53: '蛋糕', 54: '闪电', 55: '炸弹',
}));
export function conversationText(segments) {
  return segments.map(segment => {
    if (segment?.type === 'text' && typeof segment.data?.text === 'string') return segment.data.text;
    if (segment?.type !== 'face') return '';
    const raw = segment.data?.id;
    if (!(typeof raw === 'string' || (typeof raw === 'number' && Number.isSafeInteger(raw)))) return '';
    if (!/^\d{1,6}$/.test(String(raw))) return '';
    const id = String(Number(raw)), name = FACE_NAMES.get(id);
    return name ? `[QQ表情：${name}]` : `[QQ表情ID：${id}，名称未知，请勿猜测具体表情含义]`;
  }).join('').trim();
}
