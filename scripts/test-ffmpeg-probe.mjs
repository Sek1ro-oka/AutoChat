#!/usr/bin/env node
// ffmpeg 探针（voice-core.js 的 probeFfmpeg / resolveFfmpeg）单元测试。
//
// 背景（2026-11-02 复盘）：没有 ffmpeg 时媒体链路会静默降级 —— 大图不压缩、动图只给首帧，
// 只在真正处理图片时打一行「找不到 ffmpeg」。桥接现在启动就探一次、并把结果放进 /api/status，
// 所以这个探针本身要有测试盯着：必须真的去执行、必须缓存、失败时必须给出原因。
import { probeFfmpeg, resetFfmpegProbe, resolveFfmpeg } from '../src/voice-core.js';

let failed = 0;
function check(ok, label) {
  if (ok) console.log(`✅ ${label}`);
  else { failed += 1; console.error(`❌ ${label}`); }
}

// resolveFfmpeg：不存在的显式路径不能原样返回（旧实现的 bug：返回了不存在的候选路径，
// 调用方只拿到一句没有信息量的「启动失败」，而不是 ENOENT 那句「请设置 FFMPEG_PATH」）。
const bogus = process.platform === 'win32' ? 'C:\\definitely\\not\\here\\ffmpeg.exe' : '/definitely/not/here/ffmpeg';
check(resolveFfmpeg({ ffmpegPath: bogus }) !== bogus, '不存在的显式 ffmpegPath 不会被原样当作可执行文件');

// 探针：形状 + 真的执行过（detail 必须有内容，不能是空字符串）
resetFfmpegProbe();
const first = probeFfmpeg({ force: true });
check(typeof first.ok === 'boolean', 'probeFfmpeg 返回 ok 布尔值');
check(typeof first.command === 'string' && first.command.length > 0, 'probeFfmpeg 给出实际使用的命令');
check(typeof first.detail === 'string' && first.detail.length > 0, 'probeFfmpeg 给出可读的 detail（成功是版本行，失败是错误原因）');
check(Number.isFinite(first.checkedAt) && first.checkedAt > 0, 'probeFfmpeg 记录探测时间');
check(first.ok ? /ffmpeg version/i.test(first.detail) : /ENOENT|exit=|error/i.test(first.detail), '探测结果与 detail 自洽（成功给版本行、失败给原因）');

// 缓存：不加 force 时返回同一个对象（避免每张图都 spawn 一次 ffmpeg）
const second = probeFfmpeg();
check(second === first, '第二次探测命中缓存（同一对象，不会重复 spawn）');
const third = probeFfmpeg({ force: true });
check(third !== first, 'force 时重新探测（新对象）');

// reset 之后缓存失效
resetFfmpegProbe();
const fourth = probeFfmpeg();
check(fourth !== third, 'resetFfmpegProbe 之后重新探测');

console.log(failed === 0 ? '\n🎉 ffmpeg 探针测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
