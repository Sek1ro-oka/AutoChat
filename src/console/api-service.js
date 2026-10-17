// Console data builders: the service control plane (T-019).

// --- Service control plane (T-019) -----------------------------------------
// The console may only *ask* for a restart or a stop: it answers, then exits, and
// the external supervisor (scripts/supervisor.js) decides whether the bot comes
// back. Both codes are that protocol, not something guessed here.
export const EXIT_RESTART = 75;
export const EXIT_STOP = 0;

const isManaged = env => env.AUTOCHAT_SUPERVISED === '1';

// What this process knows about itself, and nothing more: `managed` comes from the
// flag the supervisor injects, never from walking the process tree.
export function buildService({ env = process.env, pid = process.pid, startedAt = Date.now(), now = Date.now() } = {}) {
  const managed = isManaged(env);
  const supervisorPid = Number.parseInt(env.AUTOCHAT_SUPERVISOR_PID ?? '', 10);
  return {
    managed,
    pid,
    supervisorPid: managed && Number.isInteger(supervisorPid) ? supervisorPid : null,
    uptimeMs: Math.max(0, now - startedAt),
    restartable: managed,
  };
}

// Reply first, exit afterwards: the delay is what lets the response reach the
// browser before this process disappears (upstream `src/bridge.js:6748-6760`).
// Never call `exit` before the caller has sent the body, and never at all when
// nobody would bring us back — that is the click that silently kills the bot.
export function requestServiceAction({ action, managed, exit, schedule = setTimeout, delayMs = 500 }) {
  if (!managed) throw new Error('SERVICE_NOT_MANAGED');
  if (action !== 'restart' && action !== 'stop') throw new Error('SERVICE_ACTION_INVALID');
  schedule(() => exit(action === 'restart' ? EXIT_RESTART : EXIT_STOP), delayMs);
  return { ok: true, action };
}

// One factory, so the server owns three one-line routes and the tests can inject
// the exit hook instead of dying with the process.
export function createServiceApi({ env = process.env, pid = process.pid, startedAt = Date.now(), exit, schedule = setTimeout } = {}) {
  const send = action => requestServiceAction({ action, managed: isManaged(env), exit, schedule });
  return {
    read: () => buildService({ env, pid, startedAt }),
    restart: () => send('restart'),
    stop: () => send('stop'),
  };
}
