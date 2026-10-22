#!/usr/bin/env node
// 回话延迟探针：从 state/social-v2.json + state/tool-calls.jsonl 读「来信 → 回复」的真实耗时。
// 只读，不改任何状态。用法：
//   node scripts/probe-reply-latency.mjs                 最近 60 分钟的总览
//   node scripts/probe-reply-latency.mjs --minutes=240   指定窗口
//   node scripts/probe-reply-latency.mjs --key=private:123 --verbose  单个会话 + 逐条拆解
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit === `--${name}`) return true;
  return hit.slice(name.length + 3);
};
const minutes = Number(flag('minutes', 60));
const onlyKey = flag('key', null);
const verbose = flag('verbose', false) === true;
const since = Date.now() - minutes * 60000;

function readJson(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return fallback; }
}

// tool-calls.jsonl 里的工具名带 mcp__snowluma__ 前缀，这里用后缀匹配。
const calls = (() => {
  const file = path.join(ROOT, 'state/tool-calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const e = JSON.parse(line);
      const t = Date.parse(e.time);
      if (!Number.isFinite(t) || t < since) return [];
      return [{ ...e, t, short: String(e.tool ?? '').replace(/^mcp__[a-z-]+__/, '') }];
    } catch { return []; }
  }).sort((a, b) => a.t - b.t);
})();

const state = readJson('state/social-v2.json', {});
const conversations = state.conversations ?? state.sessions ?? {};
const isMine = (m) => m && (m.isSelf === true || m.isOwner === true);
const rows = [];
for (const [key, st] of Object.entries(conversations)) {
  if (onlyKey && key !== onlyKey) continue;
  const msgs = (st.recentMessages ?? []).filter((m) => Number(m.time) > 0).sort((a, b) => a.time - b.time);
  for (let i = 0; i < msgs.length; i++) {
    const out = msgs[i];
    if (!isMine(out) || out.time < since) continue;
    const incoming = [...msgs.slice(0, i)].reverse().find((x) => !isMine(x));
    if (!incoming || incoming.time >= out.time) continue;
    const any = calls.filter((c) => c.key === key && c.t >= incoming.time && c.t <= out.time + 10000);
    const before = any.filter((c) => c.t <= out.time);
    const firstCall = before.find((c) => c.type === 'call');
    const sendCall = before.find((c) => c.type === 'call' && c.short === 'qq_send_message');
    // 发送结果可能比落库时间稍晚（先落库再返回），所以 result 的窗口放到 +10 秒。
    const sendResult = any.find((c) => c.type === 'result' && c.short === 'qq_send_message' && c.t >= (sendCall?.t ?? incoming.time));
    const waits = before.filter((c) => c.short === 'qq_wait_for_messages');
    rows.push({
      key, at: out.time, ms: out.time - incoming.time,
      incomingAt: incoming.time, firstCallAt: firstCall?.t ?? null, firstTool: firstCall?.short ?? null,
      sendCallAt: sendCall?.t ?? null, sendResultAt: sendResult?.t ?? null,
      waitCalls: waits.filter((c) => c.type === 'call').length,
      incoming: String(incoming.text ?? incoming.plain ?? '').slice(0, 20),
      outgoing: String(out.text ?? '').slice(0, 20),
    });
  }
}
rows.sort((a, b) => a.at - b.at);

if (!rows.length) {
  console.log(`没有符合条件的样本（最近 ${minutes} 分钟${onlyKey ? `，${onlyKey}` : ''}）`);
  process.exit(0);
}

const quant = (list, q) => list[Math.min(list.length - 1, Math.max(0, Math.round((list.length - 1) * q)))];
const share = (all, limit) => `${((all.filter((v) => v <= limit).length / all.length) * 100).toFixed(1)}%`;
const all = rows.map((r) => r.ms).sort((a, b) => a - b);
const window = `最近 ${minutes} 分钟${onlyKey ? `，${onlyKey}` : ''}`;
console.log(`${window}：${all.length} 条回复`);
console.log(`  p10 ${quant(all, 0.1)}ms  p50 ${quant(all, 0.5)}ms  p90 ${quant(all, 0.9)}ms  max ${all.at(-1)}ms`);
console.log(`  ≤5s ${share(all, 5000)}  ≤8s ${share(all, 8000)}  ≤15s ${share(all, 15000)}`);

const byKey = {};
for (const r of rows) (byKey[r.key] ??= []).push(r.ms);
for (const [key, list] of Object.entries(byKey)) {
  const sorted = list.sort((a, b) => a - b);
  console.log(`  ${key}: n=${sorted.length} p50=${quant(sorted, 0.5)}ms ≤5s=${((sorted.filter((v) => v <= 5000).length / sorted.length) * 100).toFixed(0)}%`);
}

const toFirst = rows.filter((r) => r.firstCallAt).map((r) => r.firstCallAt - r.incomingAt).sort((a, b) => a - b);
const toSend = rows.filter((r) => r.sendResultAt).map((r) => r.sendResultAt - r.sendCallAt).sort((a, b) => a - b);
if (toFirst.length) console.log(`  来信 → 首个工具调用：p50 ${quant(toFirst, 0.5)}ms（含合批 + 提示词 + 模型首步）`);
if (toSend.length) console.log(`  qq_send_message 自身：p50 ${quant(toSend, 0.5)}ms`);

if (verbose) {
  console.log('\n逐条（来信 → 首个工具 → send 调用 → send 返回 → 落库）：');
  for (const r of rows) {
    const d = (t) => (t ? `${((t - r.incomingAt) / 1000).toFixed(2)}s` : '-');
    console.log(`  ${new Date(r.at).toISOString()} ${r.key} 总 ${(r.ms / 1000).toFixed(2)}s | 首工具 ${d(r.firstCallAt)}(${r.firstTool ?? '无'}) | send ${d(r.sendCallAt)} | 返回 ${d(r.sendResultAt)} | wait×${r.waitCalls}`);
    console.log(`     来信「${r.incoming}」→ 回复「${r.outgoing}」`);
  }
} else {
  console.log('\n最近 5 条（--verbose 看逐条拆解）：');
  for (const r of rows.slice(-5)) console.log(`  ${new Date(r.at).toISOString()} ${r.key} ${(r.ms / 1000).toFixed(2)}s  「${r.incoming}」→「${r.outgoing}」`);
}
