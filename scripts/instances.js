// Multi-instance skeleton (I-10 · P2): one bot per env file.
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
// CLI: node scripts/instances.js <list|add|check|render> [name]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultIsAlive, readLockHolder } from '../src/lifecycle.js';
import {
  CODES, INSTANCE_NAME, INSTANCE_DIRECTORY, DEFAULT_CONSOLE_PORT, MIN_CONSOLE_PORT, MAX_CONSOLE_PORT,
  SECRET_KEY, validInstanceName, instanceFile, defaultDatabasePath, instanceSupervisorLockPath,
  maskSecret, parsePort, readEnvFile, readInstanceEnv, instanceSettings, baseConsolePort, nextFreePort,
  scanInstances, reservedPorts,
} from '../src/instances.js';

// Kept as re-exports so the CLI tests (test/instances.test.js) and
// scripts/supervisor.js keep importing one module. No `export *`: the surface stays
// explicit, and it keeps every name this file exported before the move. CODES /
// MIN_CONSOLE_PORT / MAX_CONSOLE_PORT / SECRET_KEY are re-exported too, because the
// moved function bodies read them; a second literal copy would drift.
export {
  CODES, INSTANCE_NAME, INSTANCE_DIRECTORY, DEFAULT_CONSOLE_PORT, MIN_CONSOLE_PORT, MAX_CONSOLE_PORT,
  SECRET_KEY, validInstanceName, instanceFile, defaultDatabasePath, instanceSupervisorLockPath,
  maskSecret, parsePort, readEnvFile, readInstanceEnv, instanceSettings, baseConsolePort, nextFreePort,
  scanInstances, reservedPorts,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const ENV_TEMPLATE = '.env.example';
export const EXIT_PROBLEM = 1;
export const EXIT_USAGE = 64;
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

const padCell = (text, width) => String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)));

function formatTable(rows) {
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => displayWidth(row[index]))));
  return `${rows.map(row => row.map((cell, index) => padCell(cell, widths[index])).join('  ').trimEnd()).join('\n')}\n`;
}

export function relativePath(root, target) {
  return relative(root, target).split(sep).join('/') || '.';
}

export function renderInstance(root, name, options = {}) {
  const isAlive = options.isAlive ?? defaultIsAlive;
  const entry = options.entry ?? readInstanceEnv(root, name);
  if (!entry.ok) return { ok: false, code: entry.code, file: entry.file };
  const settings = instanceSettings(root, name, entry.values);
  const holder = readLockHolder(settings.botLock);
  const running = Boolean(holder && isAlive(holder.pid));
  const consoleText = settings.consolePort === null
    ? '关闭（CONSOLE_PORT 无效）'
    : settings.consoleEnabled ? `开启 http://127.0.0.1:${settings.consolePort}` : `关闭（端口 ${settings.consolePort} 预留）`;
  const fields = [
    ['实例名', settings.name],
    ['配置文件', relativePath(root, settings.envFile)],
    ['BOT_QQ', settings.botQq || '<未设置>'],
    ['数据库', `${relativePath(root, settings.databasePath)}${settings.databaseDeclared ? '' : '（默认约定）'}`],
    ['控制台', consoleText],
    ['OneBot', settings.onebotUrl],
    ['人格库', `${relativePath(root, settings.personaDir)}${settings.personaDeclared ? '' : '（共享默认）'}`],
    ['单实例锁', relativePath(root, settings.botLock)],
    ['监管锁', relativePath(root, settings.supervisorLock)],
    ['运行状态', running ? `运行中（pid ${holder.pid}）` : '已停止'],
    ...settings.secrets.map(([key, value]) => [`密钥 ${key}`, maskSecret(value)]),
  ];
  return { ok: true, settings, running, fields };
}

export function checkInstances(root, options = {}) {
  const instances = scanInstances(root, options);
  const problems = [];
  const usable = instances.filter(item => item.ok);

  for (const item of instances) {
    const report = (code, message) => problems.push({ code, instances: [item.name], message });
    if (!item.validName) {
      report(CODES.invalidName, `实例文件名 "${basename(item.file)}" 不合法：名称只能是小写字母、数字、下划线、短横线，以字母或数字开头，最多 24 个字符。`);
    } else if (!item.ok) {
      report(item.code, `实例 ${item.name} 的配置文件无法读取或解析（${item.code}）。`);
    } else if (item.settings.consolePort === null) {
      report(CODES.portInvalid, `实例 ${item.name} 的 CONSOLE_PORT 不是 ${MIN_CONSOLE_PORT}-${MAX_CONSOLE_PORT} 之间的整数。`);
    }
  }

  const conflicts = (keyOf, code, describe) => {
    const buckets = new Map();
    for (const item of usable) {
      const key = keyOf(item);
      if (key) buckets.set(key, [...(buckets.get(key) ?? []), item.name]);
    }
    for (const [key, names] of buckets) {
      if (names.length > 1) problems.push({ code, instances: names, message: describe(key, names) });
    }
  };
  conflicts(item => item.settings.consolePort, CODES.portConflict, (port, names) => `控制台端口 ${port} 同时被 ${names.join('、')} 使用。`);
  // NTFS is case-insensitive, so two spellings can still be one file.
  const databaseKey = item => (process.platform === 'win32' ? item.settings.databasePath.toLowerCase() : item.settings.databasePath);
  conflicts(databaseKey, CODES.databaseDuplicate, (database, names) => `数据库文件相同：${relativePath(root, database)}（${names.join('、')}）。`);
  conflicts(item => item.settings.botQq, CODES.botQqDuplicate, (qq, names) => `BOT_QQ ${qq} 同时被 ${names.join('、')} 使用。`);
  return { ok: problems.length === 0, problems, instances };
}

function setValue(text, key, value) {
  const pattern = new RegExp(`^${key}=[^\\n]*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text}${text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
}

export function addInstance(root, name, options = {}) {
  if (!validInstanceName(name)) {
    return { ok: false, code: CODES.invalidName, message: `实例名 "${name}" 不合法：只能是小写字母、数字、下划线、短横线，以字母或数字开头，最多 24 个字符。` };
  }
  const file = instanceFile(root, name);
  if (existsSync(file)) {
    return { ok: false, code: CODES.exists, file, message: `实例 ${name} 已存在（${relativePath(root, file)}），不覆盖。` };
  }
  const templatePath = join(root, ENV_TEMPLATE);
  let template;
  try {
    template = readFileSync(templatePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  } catch {
    return { ok: false, code: CODES.templateMissing, file: templatePath, message: `找不到模板 ${ENV_TEMPLATE}，无法生成实例配置。` };
  }

  const taken = new Set([...(options.reservedPorts ?? []), ...reservedPorts(root)]);
  let port;
  if (options.port === undefined || options.port === null) {
    port = nextFreePort(taken);
    if (port === null) return { ok: false, code: CODES.portUnavailable, message: `在 ${MIN_CONSOLE_PORT}-${MAX_CONSOLE_PORT} 之间没有空闲端口可分配。` };
  } else {
    port = parsePort(options.port);
    if (port === null) return { ok: false, code: CODES.portInvalid, message: `指定的端口 ${options.port} 不在 ${MIN_CONSOLE_PORT}-${MAX_CONSOLE_PORT} 之间。` };
    if (taken.has(port)) return { ok: false, code: CODES.portConflict, message: `端口 ${port} 已被其它实例或默认 .env 占用。` };
  }

  const databasePath = defaultDatabasePath(name).split('\\').join('/');
  let text = setValue(template, 'DATABASE_PATH', databasePath);
  text = setValue(text, 'CONSOLE_PORT', String(port));
  // Explicit, so nobody has to guess that the persona library is shared.
  text = setValue(text, 'PERSONA_DIR', 'personas');
  text = [
    `# 实例 ${name} —— 由 node scripts/instances.js add ${name} 生成，结构与 .env 相同。`,
    `# 数据库在 ${databasePath}，锁也在同一目录；人格库共享 personas/。`,
    `# 控制台端口 ${port} 由脚本分配；改端口后请再跑一次 check。`,
    '# 这个文件含密钥，已被 .gitignore 忽略，不要提交。',
    '',
  ].join('\n') + text;

  mkdirSync(dirname(file), { recursive: true });
  // `wx` is the same lock-free refuse-to-overwrite the lifecycle lock uses.
  writeFileSync(file, text, { flag: 'wx' });
  return { ok: true, file, port, databasePath };
}

export const USAGE = [
  '用法：node scripts/instances.js <子命令> [实例名]',
  '',
  '  list              列出所有实例、控制台端口和运行状态',
  '  add <名称>        从 .env.example 生成 instances/<名称>.env，并分配空闲端口',
  '  check             校验实例名、端口、数据库路径和 BOT_QQ 是否冲突',
  '  render <名称>     打印某个实例的生效配置（密钥打码）',
  '',
  '实例名：小写字母、数字、下划线、短横线，以字母或数字开头，最多 24 个字符。',
  '实例文件：instances/<名称>.env；数据目录：data/bots/<名称>/；人格库共享 personas/。',
  '',
].join('\n');

function runList(root, isAlive, out) {
  const instances = scanInstances(root, { isAlive });
  if (instances.length === 0) {
    out('还没有任何实例。\n创建一个：node scripts/instances.js add alpha\n');
    return 0;
  }
  const rows = [['实例', 'QQ', '控制台', '状态', '数据库']];
  for (const item of instances) {
    const status = !item.validName ? '名称不合法' : !item.ok ? '配置错误' : item.running ? `运行中(${item.pid})` : '已停止';
    rows.push(item.ok
      ? [item.name, item.settings.botQq || '<未设置>', item.settings.consolePort === null ? '<无效>' : String(item.settings.consolePort), status, relativePath(root, item.settings.databasePath)]
      : [item.name, '-', '-', status, relativePath(root, item.file)]);
  }
  out(formatTable(rows));
  const running = instances.filter(item => item.running).length;
  out(`\n共 ${instances.length} 个实例，运行中 ${running} 个。\n启动其中一个：node scripts/supervisor.js --instance <名称>\n`);
  return 0;
}

function runCheck(root, out) {
  const result = checkInstances(root);
  out(`检查 ${result.instances.length} 个实例…\n`);
  if (result.problems.length === 0) {
    out(`检查通过：${result.instances.length} 个实例没有发现冲突。\n`);
    return 0;
  }
  out(`\n问题（${result.problems.length}）\n`);
  for (const problem of result.problems) out(`  ${problem.code}  ${problem.message}\n`);
  out(`\n结论：发现 ${result.problems.length} 个问题。\n`);
  return EXIT_PROBLEM;
}

function runRender(root, name, isAlive, out, err) {
  if (!validInstanceName(name)) {
    err(`错误 ${CODES.invalidName}：实例名 "${name}" 不合法。\n`);
    return EXIT_USAGE;
  }
  const result = renderInstance(root, name, { isAlive });
  if (!result.ok) {
    err(`错误 ${result.code}：读不到 ${relativePath(root, result.file)}。\n`);
    return EXIT_PROBLEM;
  }
  out(`实例 ${name} 的生效配置（密钥已打码）：\n`);
  const width = Math.max(...result.fields.map(([label]) => displayWidth(label)));
  for (const [label, value] of result.fields) out(`  ${padCell(label, width)}  ${value}\n`);
  return 0;
}

function runAdd(root, name, out, err) {
  if (name === undefined) {
    err(`错误 ${CODES.invalidName}：add 需要一个实例名，例如 node scripts/instances.js add alpha。\n`);
    return EXIT_USAGE;
  }
  const result = addInstance(root, name);
  if (!result.ok) {
    err(`错误 ${result.code}：${result.message}\n`);
    return result.code === CODES.invalidName ? EXIT_USAGE : EXIT_PROBLEM;
  }
  out(`已创建 ${relativePath(root, result.file)}。\n  数据库     ${result.databasePath}\n  控制台端口 ${result.port}\n`);
  out('  人格库     personas（共享，实例只引用不复制）\n');
  out('下一步：填好 BOT_QQ 与密钥，然后 node scripts/instances.js check。\n');
  return 0;
}

export function run(argv = [], options = {}) {
  const root = options.root ?? ROOT;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const out = options.out ?? (text => process.stdout.write(text));
  const err = options.err ?? (text => process.stderr.write(text));
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help') {
    out(USAGE);
    return 0;
  }
  switch (command) {
    case 'list': return runList(root, isAlive, out);
    case 'add': return runAdd(root, rest[0], out, err);
    case 'check': return runCheck(root, out);
    case 'render': return runRender(root, rest[0], isAlive, out, err);
    default:
      err(`未知子命令：${command}\n`);
      out(USAGE);
      return EXIT_USAGE;
  }
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  process.exitCode = run(process.argv.slice(2));
}
