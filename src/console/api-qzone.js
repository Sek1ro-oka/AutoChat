// Console data builders: the QQ Zone post list and its delete action (I-09).

import { budgetDay } from '../store.js';

// --- QQ Zone posts (I-09) --------------------------------------------------
// One row per evaluation outcome, exactly as `qzone.js` recorded it. Blocked and
// failed rows are described by status plus the reason enum and never carry their
// text: the outbound gate refused that text, so re-publishing it here would be
// the same mistake the gate exists to prevent. `status` is passed through as
// stored — an unknown value is shown as-is rather than relabelled.
const QZONE_HIDDEN = Object.freeze(['blocked', 'failed']);

export function buildQzonePosts({ config, store, now = Date.now(), limit = 50 }) {
  const posts = store.listQzonePosts(limit);
  const day = budgetDay(now);
  // The same window `qzone.js` gate() uses, and the same rows: the daily cap
  // counts drafts as well as published posts (a dry run is a paid evaluation).
  const counted = store.qzonePostsSince(Date.parse(`${day}T00:00:00+08:00`));
  const limitPerDay = Number(config.qzoneMaxPerDay) || 1;
  const sent = posts.filter(row => row.status === 'sent');
  return {
    enabled: Boolean(config.qzoneEnabled),
    dryRun: Boolean(config.qzoneDryRun),
    ugcRight: Number(config.qzoneUgcRight) || 4,
    hours: String(config.qzoneHours ?? ''),
    maxPerDay: limitPerDay,
    minGapHours: Number(config.qzoneMinGapHours) || 6,
    batchMin: Number(config.qzoneBatchMin) || 8,
    day,
    today: {
      sent: counted.filter(row => row.status === 'sent').length,
      drafted: counted.filter(row => row.status === 'drafted').length,
      used: counted.length,
      limit: limitPerDay,
      remaining: Math.max(0, limitPerDay - counted.length),
    },
    lastSentAt: Number(sent[0]?.at ?? 0),
    posts: posts.map(row => ({
      id: String(row.id),
      at: Number(row.at),
      status: String(row.status),
      reason: String(row.reason ?? ''),
      ugcRight: Number(row.ugc_right) || 4,
      // Deletable only when the protocol side confirmed a tid: a draft or a blocked
      // attempt never reached QZone, so there is nothing out there to delete.
      removable: row.status === 'sent' && String(row.tid ?? '') !== '',
      text: QZONE_HIDDEN.includes(row.status) ? '' : String(row.text ?? ''),
    })),
  };
}

// A rejected delete must never look like a success: the row is only marked
// `deleted` after `delete_qzone_msg` came back clean, and every failure carries a
// stable code plus (when the transport has one) the raw message, so the page can
// say what actually went wrong instead of "内部错误".
const DELETE_OFFLINE = Object.freeze(['ONEBOT_NOT_CONNECTED', 'ONEBOT_DISCONNECTED', 'ONEBOT_SEND_FAILED']);
const tagged = (code, detail) => Object.assign(new Error(code), { detail: String(detail ?? '').slice(0, 160) });

export async function deleteQzonePost({ config, store, transport, id, now = Date.now() }) {
  const postId = String(id ?? '');
  const row = postId ? store.listQzonePosts(200).find(item => String(item.id) === postId) : null;
  if (!row) throw new Error('QZONE_POST_NOT_FOUND');
  if (row.status === 'deleted') throw new Error('QZONE_POST_ALREADY_DELETED');
  // No tid means no post on the QZone side: refuse before touching the protocol.
  if (row.status !== 'sent' || !String(row.tid ?? '')) throw new Error('QZONE_POST_NO_TID');
  if (typeof transport?.call !== 'function') throw tagged('QZONE_DELETE_UNAVAILABLE', 'no_transport');
  let response;
  try {
    response = await transport.call('delete_qzone_msg', { tid: String(row.tid) });
  } catch (error) {
    const raw = String(error?.message ?? 'unknown');
    const code = DELETE_OFFLINE.includes(raw)
      ? 'QZONE_DELETE_UNAVAILABLE'
      : raw === 'ONEBOT_TIMEOUT' ? 'QZONE_DELETE_TIMEOUT'
        : raw === 'ONEBOT_ACTION_FAILED' ? 'QZONE_DELETE_REJECTED' : 'QZONE_DELETE_FAILED';
    throw tagged(code, raw);
  }
  // A resolved frame can still carry a non-zero retcode (a fake transport in a
  // test, or a protocol adapter that reports errors inline): that is a failure.
  const retcode = Number(response?.retcode ?? response?.code ?? 0);
  if (retcode !== 0) throw tagged('QZONE_DELETE_REJECTED', `retcode ${retcode}`);
  store.setQzonePostStatus(postId, 'deleted', 'console');
  return { id: postId, deleted: true, ...buildQzonePosts({ config, store, now }) };
}
