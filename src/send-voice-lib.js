// 语音发送共享库 —— 薄转发层（唯一实现在 voice-core.js）。
//
// 为什么保留这个文件：src/bridge.js 与若干测试都 import 它。让各模块**共用同一份**
// 音频解析与 ffprobe 探测逻辑，避免"两份实现各自演化"——那正是行为漂移的高发区。
// 独立工具（上级 voice-tool/ 里的 voice-gui.mjs 与 voice-cli.mjs）经
// `../qq-bridge/src/voice-core.js` 引同一份实现，同样不复制代码。
export {
  AUDIO_EXTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SECONDS,
  isAudioFile,
  formatBytes,
  formatDuration,
  listAudioFiles,
  resolveAudioSource,
  safeJoinLibrary,
  probeAudio,
  inspectAudio,
  describeAudio,
  parseTargetKey,
  sanitizeUploadName,
  uniqueLibraryPath,
  VOLUME_MIN,
  VOLUME_MAX,
  LOUDNESS_TARGETS,
  resolveAudioProcessing,
  resolveFfmpeg,
  // ffmpeg 探针：桥接启动时用它判断这台机器到底能不能压图/抽帧（缺件要能被看见），
  // 挂在薄转发层里是为了和 resolveFfmpeg 一起走同一个出口，不另开引用路径。
  probeFfmpeg,
  resetFfmpegProbe,
  processAudioVolume,
  cleanupTemp
} from './voice-core.js';