import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { budgetDay } from '../src/store.js';

const config = loadConfig();
const db = new DatabaseSync(config.databasePath, { readOnly: true });
try {
  console.log(JSON.stringify({
    day: budgetDay(),
    acceptedEvents: db.prepare('SELECT count(*) AS total FROM events').get().total,
    acceptedPrivateEvents: db.prepare("SELECT count(*) AS total FROM events WHERE key LIKE '%:private:%'").get().total,
    acceptedGroupEvents: db.prepare("SELECT count(*) AS total FROM events WHERE key LIKE '%:group:%'").get().total,
    privateSessions: db.prepare("SELECT count(*) AS total FROM sessions WHERE scope='private'").get().total,
    groupSessions: db.prepare("SELECT count(*) AS total FROM sessions WHERE scope LIKE 'group:%'").get().total,
    charges: db.prepare('SELECT state,count(*) AS total, sum(actual) AS actualMicro FROM charges WHERE day=? GROUP BY state').all(budgetDay()),
  }));
} finally { db.close(); }
