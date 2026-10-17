// Read-only aggregation hub.
//
// The console used to answer for one bot. With several instances on one machine,
// /api/instances has to look at every other instance's database as well — without
// writing to it, and without one broken instance taking the endpoint down:
//   - every row is wrapped in try/catch and degrades to `ok: false`;
//   - a missing database file is reported, never created (`Store` would happily
//     make an empty sqlite and hide the mistake);
//   - the read-only `Store` opens without schema or migration (see src/store.js);
//   - the whole snapshot is cached for a few seconds, because a page refresh
//     should not open N databases twice.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../config.js';
import { INSTANCE_DIRECTORY, scanInstances } from '../instances.js';
import { defaultIsAlive } from '../lifecycle.js';
import { Store } from '../store.js';
import { costCards } from './api-cost.js';

const TTL_MS = 5000;
const WINDOWS = ['today', 'week', 'month'];
const EMPTY_CARD = Object.freeze({ totalMicro: 0, calls: 0 });
const FALLBACK_PRICING = '价格按本机配置估算';

// Cards carry four price fields each; the hub only shows two numbers per row.
const pick = card => ({ totalMicro: Number(card?.totalMicro) || 0, calls: Number(card?.calls) || 0 });
const zeroCards = () => ({ today: { ...EMPTY_CARD }, week: { ...EMPTY_CARD }, month: { ...EMPTY_CARD } });

export function createHub({ root = process.cwd(), config = null, isAlive = defaultIsAlive, now = Date.now, ttlMs = TTL_MS } = {}) {
  // Closure-scoped, not module-scoped: two hubs (tests, or two roots) must not share
  // one snapshot.
  let cache = null;

  function blank(row) {
    const settings = row.settings ?? null;
    return {
      name: row.name,
      running: Boolean(row.running),
      pid: row.running ? row.pid : null,
      consolePort: settings?.consolePort ?? null,
      consoleEnabled: Boolean(settings?.consoleEnabled),
      botQq: settings?.botQq || null,
      database: false,
      ok: false,
      error: row.ok ? null : row.code,
      warnings: [],
      cards: zeroCards(),
    };
  }

  function readRow(row, at) {
    const entry = blank(row);
    if (!row.ok) return entry; // the env file itself is unreadable
    const settings = row.settings;
    const present = existsSync(settings.databasePath);
    entry.database = present;
    // Prices come from the instance's own env first: instances may run different
    // models, and one shared price table would then be wrong for both.
    let pricing = config;
    try {
      pricing = loadConfig({ ...process.env, ...row.values });
    } catch (error) {
      if (!config) {
        entry.error = error.message;
        return entry;
      }
      entry.warnings.push(FALLBACK_PRICING);
    }
    if (!present) {
      entry.error = 'DATABASE_MISSING';
      return entry;
    }
    const store = new Store(settings.databasePath, { readonly: true });
    try {
      const cards = costCards({ config: pricing, store, now: at });
      entry.cards = { today: pick(cards.today), week: pick(cards.week), month: pick(cards.month) };
      entry.ok = true;
    } catch (error) {
      entry.error = error.message;
    } finally {
      store.close();
    }
    return entry;
  }

  function snapshot(at) {
    const rows = scanInstances(resolve(root), { isAlive }).map(row => {
      try {
        return readRow(row, at);
      } catch (error) {
        return { ...blank(row), error: String(error?.message ?? error) };
      }
    });
    const aggregate = zeroCards();
    for (const row of rows) {
      if (!row.ok) continue;
      for (const window of WINDOWS) {
        aggregate[window].totalMicro += row.cards[window].totalMicro;
        aggregate[window].calls += row.cards[window].calls;
      }
    }
    return {
      directory: INSTANCE_DIRECTORY,
      scannedAt: at,
      counts: {
        total: rows.length,
        running: rows.filter(row => row.running).length,
        ready: rows.filter(row => row.ok).length,
      },
      instances: rows,
      aggregate,
    };
  }

  return {
    list() {
      const at = now();
      if (cache && at - cache.at < ttlMs) return cache.value;
      const value = snapshot(at);
      cache = { at, value };
      return value;
    },
  };
}
