export const LOG_CONTEXT_FIELDS = [
  'project_id',
  'task_id',
  'run_id',
  'workflow_id',
  'worker_id',
  'correlation_id',
] as const;

export type LogContext = Partial<Record<(typeof LOG_CONTEXT_FIELDS)[number], string | null>>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  clock?: () => Date;
  sink?: (line: string) => void;
  secretValues?: readonly string[];
}

export interface Logger {
  child(context: LogContext): Logger;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const defaultContext: Required<LogContext> = {
  project_id: null,
  task_id: null,
  run_id: null,
  workflow_id: null,
  worker_id: null,
  correlation_id: null,
};

function redact(value: string, secretValues: readonly string[]): string {
  let result = value;
  for (const secret of secretValues) {
    if (secret.length > 0) result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const clock = options.clock ?? (() => new Date());
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const secrets = [...(options.secretValues ?? [])]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);

  function makeLogger(context: LogContext): Logger {
    function write(level: LogLevel, message: string, recordContext: LogContext = {}): void {
      const mergedContext = { ...defaultContext, ...context, ...recordContext };
      const record = {
        timestamp: clock().toISOString(),
        level,
        message: redact(message, secrets),
        project_id: mergedContext.project_id === null ? null : redact(mergedContext.project_id, secrets),
        task_id: mergedContext.task_id === null ? null : redact(mergedContext.task_id, secrets),
        run_id: mergedContext.run_id === null ? null : redact(mergedContext.run_id, secrets),
        workflow_id: mergedContext.workflow_id === null ? null : redact(mergedContext.workflow_id, secrets),
        worker_id: mergedContext.worker_id === null ? null : redact(mergedContext.worker_id, secrets),
        correlation_id: mergedContext.correlation_id === null ? null : redact(mergedContext.correlation_id, secrets),
      };
      sink(JSON.stringify(record));
    }

    return {
      child: (childContext) => makeLogger({ ...context, ...childContext }),
      debug: (message, recordContext) => write('debug', message, recordContext),
      info: (message, recordContext) => write('info', message, recordContext),
      warn: (message, recordContext) => write('warn', message, recordContext),
      error: (message, recordContext) => write('error', message, recordContext),
    };
  }

  return makeLogger({});
}
