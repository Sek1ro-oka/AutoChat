// Console data builders. Pure functions over `{ config, store, bot, transport,
// runtime }` so the console can be unit tested without opening a socket.
//
// This barrel is the console API's contract in one readable place: every domain
// module is re-exported by explicit name (no star re-exports), so two domains
// that happened to grow a same-named helper could not silently drop one of them.

export {
  redact, buildSummary, buildSessions, buildCharges, buildConfig, buildSettings, applySetting,
  buildInstances,
} from './api-core.js';

export { COST_RANGES, buildCost, buildCostTurns } from './api-cost.js';

export {
  buildPersonas, buildPersonaFile, buildSocial, buildSlang, buildSlangEntry,
  buildStickers, buildStickerEntry, buildGroups, applyGroupPatch,
} from './api-content.js';

export { buildQzonePosts, deleteQzonePost } from './api-qzone.js';

export {
  EXIT_RESTART, EXIT_STOP, buildService, requestServiceAction, createServiceApi,
} from './api-service.js';
