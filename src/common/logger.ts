/**
 * @module common/logger
 *
 * Minimal structured logger. In production this would delegate to pino/winston
 * and ship to your observability stack; here it provides correlation-id aware,
 * leveled, JSON-friendly output with zero dependencies.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  readonly correlationId?: string;
  readonly [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info',
    private readonly baseContext: LogContext = {},
  ) {}

  /** Derive a child logger that inherits and extends the current context. */
  child(scope: string, context: LogContext = {}): Logger {
    return new Logger(`${this.scope}:${scope}`, this.minLevel, { ...this.baseContext, ...context });
  }

  debug(message: string, context: LogContext = {}): void { this.emit('debug', message, context); }
  info(message: string, context: LogContext = {}): void { this.emit('info', message, context); }
  warn(message: string, context: LogContext = {}): void { this.emit('warn', message, context); }
  error(message: string, context: LogContext = {}): void { this.emit('error', message, context); }

  private emit(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...this.baseContext,
      ...context,
    };
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export const rootLogger = new Logger('bucket-no-more');
