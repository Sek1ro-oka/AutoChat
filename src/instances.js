// Shared multi-instance primitives (I-10 · P2), used by the CLI
// (scripts/instances.js) and by the console's read-only hub (src/console/hub.js).
//
// src/schema.js has no `bot_id`, so the unit of isolation is a whole database file:
// instances/<name>.env holds the configuration, data/bots/<name>/ holds the database
// and its lock, and the persona library is shared, because one persona card is meant
// to serve several bots at once.
//
// Names are ^[a-z0-9][a-z0-9_-]{0,23}$ (a path segment, so lowercase and no dots),
// ports are unique because every console binds 127.0.0.1, and nothing in this file
// spawns a process or opens a socket — the convention is testable in-process.
//
// The subcommands and the table rendering stay in scripts/instances.js; this module
// holds only what a second caller (the hub) also needs, so neither copy can drift.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defaultIsAlive, lockPathFor, readLockHolder } from './lifecycle.js';

export const INSTANCE_NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export const INSTANCE_DIRECTORY = 'instances';
// The same default as src/config.js, so the first instance cannot steal the port the
// single-instance setup already uses.
export const DEFAULT_CONSOLE_PORT = 3200;
export const MIN_CONSOLE_PORT = 1024;
export const MAX_CONSOLE_PORT = 65535;

// Stable codes: scripts and reports quote these strings, so their spelling is API.
export const CODES = Object.freeze({
  invalidName: 'INVALID_INSTANCE_NAME', exists: 'INSTANCE_EXISTS', missing: 'INSTANCE_MISSING',
  unreadable: 'INSTANCE_UNREADABLE', invalid: 'INSTANCE_INVALID', templateMissing: 'TEMPLATE_MISSING',
  portConflict: 'PORT_CONFLICT', portInvalid: 'PORT_INVALID', portUnavailable: 'PORT_UNAVAILABLE',
  databaseDuplicate: 'DATABASE_DUPLICATE', botQqDuplicate: 'BOT_QQ_DUPLICATE',
});

// Masked by name, never by value: a new provider key is covered without an edit.
export const SECRET_KEY = /(key|token|secret|password)/i;

export function validInstanceName(name) {
  return typeof name === 'string' && INSTANCE_NAME.test(name);
}
export function instanceFile(root, name) {
  return join(root, INSTANCE_DIRECTORY, `${name}.env`);
}
// Derived from the name, not from the port: changing a port never loses a database.
export function defaultDatabasePath(name) {
  return join('data', 'bots', name, 'autochat.sqlite');
}
// Per-instance supervisor mutex; the bot lock stays next to its own database, which
// is what keeps two instances from colliding on either one.
export function instanceSupervisorLockPath(root, name) {
  return join(root, 'data', `autochat-supervisor-${name}.lock`);
}

export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '<未设置>';
  // Too short to keep a tail: a 4-character "mask" would leak a short token.
  return text.length < 12 ? '<已设置>' : `****${text.slice(-4)}`;
}

export function parsePort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= MIN_CONSOLE_PORT && number <= MAX_CONSOLE_PORT ? number : null;
}

// One reader for both `.env` and `instances/*.env`: node's own parser, so the CLI
// and the child process cannot disagree about what a file says.
export function readEnvFile(file) {
  try {
    return parseEnv(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

export function readInstanceEnv(root, name) {
  const file = instanceFile(root, name);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, code: error?.code === 'ENOENT' ? CODES.missing : CODES.unreadable, file };
  }
  try {
    return { ok: true, file, values: parseEnv(text.replace(/^\uFEFF/, '')) };
  } catch {
    return { ok: false, code: CODES.invalid, file };
  }
}

export function instanceSettings(root, name, values = {}) {
  const text = key => (typeof values[key] === 'string' ? values[key].trim() : '');
  const declaredDatabase = text('DATABASE_PATH');
  const declaredPersona = text('PERSONA_DIR');
  const databasePath = resolve(root, declaredDatabase || defaultDatabasePath(name));
  return {
    name,
    envFile: instanceFile(root, name),
    botQq: text('BOT_QQ'),
    databasePath,
    databaseDeclared: declaredDatabase !== '',
    botLock: lockPathFor(databasePath),
    supervisorLock: instanceSupervisorLockPath(root, name),
    consolePort: parsePort(text('CONSOLE_PORT') || String(DEFAULT_CONSOLE_PORT)),
    consoleEnabled: text('CONSOLE_ENABLED').toLowerCase() === 'true',
    onebotUrl: text('ONEBOT_WS_URL') || 'ws://127.0.0.1:3001',
    personaDir: resolve(root, declaredPersona || 'personas'),
    personaDeclared: declaredPersona !== '',
    secrets: Object.keys(values).filter(key => SECRET_KEY.test(key)).sort().map(key => [key, values[key]]),
  };
}

// The port the single-instance `.env` would bind: reserved, because that bot may be
// running too. Falls back to the default so a fresh checkout cannot hand 3200 away.
export function baseConsolePort(root) {
  return parsePort(readEnvFile(join(root, '.env')).CONSOLE_PORT) ?? DEFAULT_CONSOLE_PORT;
}

export function nextFreePort(reserved, start = DEFAULT_CONSOLE_PORT, max = MAX_CONSOLE_PORT) {
  const taken = new Set([...reserved].map(Number));
  const first = Math.max(MIN_CONSOLE_PORT, Math.trunc(Number(start) || DEFAULT_CONSOLE_PORT));
  for (let port = first; port <= max; port += 1) {
    if (!taken.has(port)) return port;
  }
  return null;
}

export function scanInstances(root, { isAlive = defaultIsAlive } = {}) {
  let files = [];
  try {
    files = readdirSync(join(root, INSTANCE_DIRECTORY)).filter(file => file.endsWith('.env'));
  } catch {
    return [];
  }
  return files.map(file => basename(file, '.env')).sort().map(name => {
    const validName = validInstanceName(name);
    const entry = readInstanceEnv(root, name);
    if (!entry.ok) return { name, validName, ok: false, code: entry.code, file: entry.file };
    const settings = instanceSettings(root, name, entry.values);
    const holder = readLockHolder(settings.botLock);
    const running = Boolean(holder && isAlive(holder.pid));
    return {
      name, validName, ok: true, file: entry.file, values: entry.values, settings,
      running, pid: running ? holder.pid : null,
    };
  });
}

// Ports already spoken for: every instance file, plus the default bot.
export function reservedPorts(root) {
  const ports = new Set([baseConsolePort(root)]);
  for (const item of scanInstances(root, { isAlive: () => false })) {
    if (item.ok && item.settings.consolePort !== null) ports.add(item.settings.consolePort);
  }
  return ports;
}
