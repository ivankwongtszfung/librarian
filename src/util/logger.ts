// A tiny leveled, structured logger. One JSON line per event so a service
// supervisor (launchd/systemd) can capture and grep the daemon's output — the
// alternative, bare console.log, vanishes with the terminal. No dependency: the
// standard library does everything a daemon this size needs.

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const l = (process.env.LIBRARIAN_LOG_LEVEL ?? 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as string[]).includes(l) ? (l as Level) : 'info';
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(min: Level = envLevel()): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[min]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
    // Errors and warnings to stderr, everything else to stdout — a supervisor can split the streams.
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** Turn an unknown thrown value into loggable fields without losing the stack. */
export function errFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { err: err.message, stack: err.stack };
  return { err: String(err) };
}

export const log = createLogger();
