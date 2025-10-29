import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const levelRank: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export interface LoggerOptions {
  level: LogLevel;
  channel: vscode.OutputChannel;
  prefix?: string;
}

export class Logger {
  private level: LogLevel;
  private channel: vscode.OutputChannel;
  private prefix?: string;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.channel = options.channel;
    this.prefix = options.prefix;
  }

  public setLevel(level: LogLevel) {
    this.level = level;
  }

  private shouldLog(lvl: LogLevel): boolean {
    return levelRank[lvl] <= levelRank[this.level];
  }

  private fmt(level: LogLevel, message: string, details?: unknown): string {
    const ts = new Date().toISOString();
    const head = this.prefix ? `[${ts}] [${level.toUpperCase()}] [${this.prefix}]` : `[${ts}] [${level.toUpperCase()}]`;
    if (details === undefined) {
      return `${head} ${message}`;
    }
    let tail: string;
    try {
      if (details instanceof Error) {
        tail = `${details.name}: ${details.message}\n${details.stack ?? ''}`;
      } else if (typeof details === 'object') {
        tail = JSON.stringify(details, null, 2);
      } else {
        tail = String(details);
      }
    } catch {
      tail = String(details);
    }
    return `${head} ${message}\n${tail}`;
  }

  public error(message: string, err?: unknown) {
    if (!this.shouldLog('error')) return;
    this.channel.appendLine(this.fmt('error', message, err));
  }

  public warn(message: string, details?: unknown) {
    if (!this.shouldLog('warn')) return;
    this.channel.appendLine(this.fmt('warn', message, details));
  }

  public info(message: string, details?: unknown) {
    if (!this.shouldLog('info')) return;
    this.channel.appendLine(this.fmt('info', message, details));
  }

  public debug(message: string, details?: unknown) {
    if (!this.shouldLog('debug')) return;
    this.channel.appendLine(this.fmt('debug', message, details));
  }

  public trace(message: string, details?: unknown) {
    if (!this.shouldLog('trace')) return;
    this.channel.appendLine(this.fmt('trace', message, details));
  }

  public group(title: string, body: () => void) {
    this.channel.appendLine(`── ${title} ──`);
    try {
      body();
    } finally {
      this.channel.appendLine(`── end ──`);
    }
  }
}

export function createOutputChannelLogger(level: LogLevel, name = 'Multi Cursor AI'): Logger {
  const channel = vscode.window.createOutputChannel(name);
  return new Logger({ level, channel, prefix: 'ext' });
}