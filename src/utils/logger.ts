/**
 * Logger utility for controlling log output based on DEBUG_MODE environment variable
 */

export enum LogLevel {
  ERROR = 0,  // Always output (errors)
  WARN = 1,   // Warnings
  INFO = 2,   // Normal information (default)
  DEBUG = 3   // Debug details (development only)
}

export interface LoggerConfig {
  level: LogLevel;
  prefix: string;
}

export class Logger {
  private config: LoggerConfig;

  constructor(prefix: string, level?: LogLevel) {
    this.config = {
      prefix,
      level: level ?? this.getLogLevelFromEnv()
    };
  }

  private getLogLevelFromEnv(): LogLevel {
    const debugMode = process.env.DEBUG_MODE === 'true';
    return debugMode ? LogLevel.DEBUG : LogLevel.INFO;
  }

  error(message: string, ...args: any[]): void {
    console.error(`[${this.config.prefix}]`, message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.WARN) {
      console.warn(`[${this.config.prefix}]`, message, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.INFO) {
      console.log(`[${this.config.prefix}]`, message, ...args);
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.DEBUG) {
      console.log(`[${this.config.prefix}]`, message, ...args);
    }
  }
}
