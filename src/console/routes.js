// The console's endpoint tables: pathname -> handler. Pure mapping, so server.js
// only has to own the HTTP transport (auth, dispatch, static assets).

import {
  buildSummary, buildSessions, buildCharges, buildConfig, buildSettings, buildInstances,
  buildQzonePosts, buildCost, buildCostTurns,
  buildPersonas, buildPersonaFile, buildSocial, buildGroups, buildSlang, buildSlangEntry,
  buildStickers, buildStickerEntry, applySetting, deleteQzonePost, applyGroupPatch,
} from './api.js';
import { readLogs } from './logs.js';

export function createRoutes({
  config, store, hub, bot, transport, runtime, personas, social, slang, stickers,
  now, startedAt, logDirectory,
  requirePersonas, requireSocial, requireSlang, requireStickers, login, service,
}) {
  const reads = {
    '/api/summary': () => buildSummary({ config, store, bot, transport, runtime, now: now(), startedAt }),
    '/api/sessions': (url) => buildSessions({ store, limit: Number(url.searchParams.get('limit')) || 200 }),
    '/api/charges': (url) => buildCharges({ store, days: Number(url.searchParams.get('days')) || 30 }),
    '/api/logs': (url) => ({ logs: readLogs(logDirectory, Number(url.searchParams.get('limit')) || 120) }),
    '/api/config': () => buildConfig({ config }),
    '/api/settings': () => buildSettings({ config, store }),
    '/api/qzone/posts': () => buildQzonePosts({ config, store, now: now() }),
    '/api/cost': (url) => buildCost({ config, store, range: url.searchParams.get('range') ?? '24h', now: now() }),
    '/api/cost/turns': (url) => buildCostTurns({
      config, store, session: url.searchParams.get('session') ?? '',
      limit: Number(url.searchParams.get('limit')) || 100,
    }),
    // Every instance on this machine, read through a read-only hub (T-033).
    '/api/instances': () => buildInstances({ hub }),
    '/api/personas': () => buildPersonas({ personas }),
    '/api/personas/file': (url) => buildPersonaFile({
      personas, kind: url.searchParams.get('kind') === 'behavior' ? 'behavior' : 'card',
      name: url.searchParams.get('name') ?? '',
    }),
    '/api/social': () => buildSocial({ social, now: now() }),
    '/api/groups': () => buildGroups({ config, personas, social, slang, now: now() }),
    '/api/slang': () => buildSlang({ slang }),
    '/api/slang/entry': (url) => buildSlangEntry({ slang: requireSlang(), id: url.searchParams.get('id') ?? '' }),
    '/api/stickers': () => buildStickers({ stickers }),
    '/api/stickers/entry': (url) => buildStickerEntry({ stickers: requireStickers(), id: url.searchParams.get('id') ?? '' }),
    // The backup is a plain JSON document; restoring goes through the write route.
    '/api/slang/export': () => requireSlang().exportAll(),
    // Console login: status only, and never anything that came out of the
    // WebUI token or the Credential (see src/napcat-webui.js).
    '/api/login/status': () => login.status(),
    // Read-only view of what this process knows about its own supervision (T-019).
    '/api/service': () => service.read(),
  };

  // Every write returns the freshly described persona state so the page can
  // re-render from one response instead of chaining a follow-up GET.
  const writes = {
    '/api/personas/file': (url, body) => {
      const target = requirePersonas();
      if (body?.kind === 'behavior') return { restart: true, ...target.saveBehavior(body?.content), ...buildPersonas({ personas }) };
      return { saved: target.save(body?.name, body?.content), ...buildPersonas({ personas }) };
    },
    '/api/personas/delete': (url, body) => {
      const target = requirePersonas();
      return { deleted: target.remove(body?.name), ...buildPersonas({ personas }) };
    },
    '/api/personas/active': (url, body) => {
      const target = requirePersonas();
      return { active: target.setActive(body?.name ?? ''), ...buildPersonas({ personas }) };
    },
    '/api/settings': (url, body) => applySetting({ config, store, name: body?.name, value: body?.value }),
    // Deleting a post is a protocol action: `delete_qzone_msg` first, row second.
    '/api/qzone/delete': (url, body) => deleteQzonePost({ config, store, transport, id: body?.id }),
    '/api/social/config': (url, body) => requireSocial().setParams(body ?? {}),
    // Per-group specialisation: one endpoint, routed by `subsystem`, so the page
    // has a single save path for persona / social / slang / reset.
    '/api/groups/config': (url, body) => {
      applyGroupPatch({ personas, social, slang, store, group: body?.group, patch: body ?? {} });
      return buildGroups({ config, personas, social, slang, now: now() });
    },
    // Slang review (Phase 4). Every write returns the re-described library, so
    // the page re-renders from one response instead of chaining a read.
    '/api/slang/config': (url, body) => requireSlang().setParams(body ?? {}),
    '/api/slang/extract': (url, body) => requireSlang().extract({ group: body?.group ?? null }).then(result => ({ result, ...requireSlang().describe() })),
    '/api/slang/status': (url, body) => requireSlang().setStatus(body?.id, body?.status),
    '/api/slang/entry': (url, body) => requireSlang().edit(body?.id, body ?? {}),
    '/api/slang/scopes': (url, body) => requireSlang().setScopes(body?.id, body?.groups),
    '/api/slang/delete': (url, body) => requireSlang().remove(body?.id),
    '/api/slang/lookup': (url, body) => requireSlang().lookup(body?.id),
    '/api/slang/import': (url, body) => requireSlang().importAll(body?.text),
    // Sticker library (Phase 6). Every write re-describes the library, so the
    // page re-renders from one response instead of chaining a read.
    '/api/stickers/config': (url, body) => requireStickers().setParams(body ?? {}),
    '/api/stickers/status': (url, body) => requireStickers().setStatus(body?.id, body?.status),
    '/api/stickers/entry': (url, body) => requireStickers().edit(body?.id, body ?? {}),
    '/api/stickers/delete': (url, body) => requireStickers().remove(body?.id),
    '/api/stickers/upload': (url, body) => requireStickers().upload(body ?? {}),
    // A new QR code for the bot account. Writes go through the usual header
    // token + loopback-origin gate, like every other action that changes state.
    '/api/login/qr': () => login.refresh(),
    // Restart/stop: the reply is written before the delayed exit, so the browser
    // gets a receipt instead of a dropped connection (T-019).
    '/api/service/restart': () => service.restart(),
    '/api/service/stop': () => service.stop(),
  };

  return { reads, writes };
}
