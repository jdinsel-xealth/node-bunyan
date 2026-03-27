/**
 * Copyright (c) 2017 Trent Mick.
 * Copyright (c) 2017 Joyent Inc.
 *
 * The bunyan logging library for node.js.
 * Minimal console-only version: createLogger, child loggers, JSON to stdout.
 */

import { EventEmitter } from 'events';
import { format, inspect } from 'util';
import * as os from 'os';
import * as assert from 'assert';
import { Writable } from 'stream';
import pkg from '../package.json';

/*
 * Bunyan log format version. This becomes the 'v' field on all log records.
 * This will be incremented if there is any backward incompatible change to
 * the log record format. Details will be in 'CHANGES.md' (the change log).
 */
const LOG_VERSION = 0;


//---- Types

export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** A stream-like object that bunyan can write JSON log lines to. */
export interface StreamLike {
    write(chunk: string): unknown;
}

/** Configuration for a single output stream. */
export interface StreamSpec {
    stream?: StreamLike;
    level?: number | LogLevelName;
    closeOnExit?: boolean;
}

interface StreamEntry {
    stream: StreamLike;
    level: number;
    closeOnExit: boolean;
}

/** Options for creating a root logger. */
export interface LoggerOptions {
    /** Logger name. Required. Included in every log record. */
    name: string;
    /** Log level (name or number). Defaults to 'info'. */
    level?: number | LogLevelName;
    /** A single writable stream. Cannot be combined with `streams`. */
    stream?: StreamLike;
    /** Multiple output streams with per-stream levels. Cannot be combined with `stream`. */
    streams?: StreamSpec[];
    /** Override the hostname field. Defaults to os.hostname(). */
    hostname?: string;
    /** Override the pid field. Defaults to process.pid. */
    pid?: number;
    /** Any additional fields become defaults on every log record. */
    [key: string]: unknown;
}

/** Options for creating a child logger via `logger.child()`. */
export interface ChildLoggerOptions {
    /** Cannot be set on a child logger. */
    name?: never;
    level?: number | LogLevelName;
    stream?: StreamLike;
    streams?: StreamSpec[];
    /** Additional fields bound to every record from this child. */
    [key: string]: unknown;
}

/**
 * A log method at a specific level.
 *
 * Called with no args → returns boolean indicating whether this level is enabled.
 * Called with an Error as first arg → logs the error with `err` field populated.
 * Called with a fields object → merges fields into the log record.
 * Called with a string → uses it as the message (printf-style formatting supported).
 */
export interface LogMethod {
    (): boolean;
    (error: Error, msg?: string, ...params: unknown[]): void;
    (fields: Record<string, unknown>, msg?: string, ...params: unknown[]): void;
    (msg: string, ...params: unknown[]): void;
}

interface LogRecord {
    v: number;
    level: number;
    name?: string;
    hostname?: string;
    pid?: number;
    time: Date;
    msg: string;
    [key: string]: unknown;
}


//---- Levels

export const TRACE = 10;
export const DEBUG = 20;
export const INFO = 30;
export const WARN = 40;
export const ERROR = 50;
export const FATAL = 60;

export const levelFromName: Readonly<Record<LogLevelName, number>> = {
    trace: TRACE,
    debug: DEBUG,
    info: INFO,
    warn: WARN,
    error: ERROR,
    fatal: FATAL,
};

export const nameFromLevel: Readonly<Record<number, string>> = Object.fromEntries(
    Object.entries(levelFromName).map(([name, level]) => [level, name])
);

/**
 * Resolve a level number or name (case-insensitive) to a level number value.
 */
export function resolveLevel(nameOrNum: string | number): number {
    if (typeof nameOrNum === 'string') {
        const level = levelFromName[nameOrNum.toLowerCase() as LogLevelName];
        if (level === undefined) {
            throw new Error(`unknown level name: "${nameOrNum}"`);
        }
        return level;
    }
    if (nameOrNum < 0 || Math.floor(nameOrNum) !== nameOrNum) {
        throw new TypeError(`level is not a positive integer: ${nameOrNum}`);
    }
    return nameOrNum;
}


//---- Internal helpers

function isWritable(obj: unknown): obj is StreamLike {
    if (obj instanceof Writable) return true;
    return typeof (obj as Partial<StreamLike>).write === 'function';
}

function mkRecord(log: Logger, minLevel: number, args: unknown[]): LogRecord {
    let fields: Record<string, unknown> | null = null;
    let msgArgs: unknown[];

    if (args[0] instanceof Error) {
        // log.<level>(err, ...)
        const err = args[0];
        fields = {
            err: {
                message: err.message,
                name: err.name,
                stack: err.stack,
                code: (err as NodeJS.ErrnoException).code,
                signal: (err as unknown as { signal?: string }).signal,
            },
        };
        msgArgs = args.length === 1
            ? [(fields.err as { message: string }).message]
            : args.slice(1);
    } else if (typeof args[0] !== 'object' || Array.isArray(args[0])) {
        // log.<level>(msg, ...)
        fields = null;
        msgArgs = args.slice();
    } else if (Buffer.isBuffer(args[0])) {
        // log.<level>(buf, ...) — almost certainly a mistake, inspect it
        fields = null;
        msgArgs = [...args];
        msgArgs[0] = inspect(args[0]);
    } else {
        // log.<level>(fields, msg, ...)
        fields = args[0] as Record<string, unknown>;
        if (fields?.err instanceof Error && args.length === 1) {
            msgArgs = [(fields.err as Error).message];
        } else {
            msgArgs = args.slice(1);
        }
    }

    const rec: LogRecord = { ...log.fields } as LogRecord;
    rec.level = minLevel;
    if (fields) {
        Object.assign(rec, fields);
    }
    rec.msg = format(...(msgArgs as [unknown, ...unknown[]]));
    rec.time ??= new Date();
    rec.v = LOG_VERSION;

    return rec;
}

function mkLogEmitter(minLevel: number): LogMethod {
    return function (this: Logger, ...args: unknown[]): boolean | void {
        if (args.length === 0) {
            return this._level <= minLevel;
        }
        if (this._level <= minLevel) {
            this._emit(mkRecord(this, minLevel, args));
        }
    } as unknown as LogMethod;
}


//---- Logger class

export class Logger extends EventEmitter {
    _level: number = Number.POSITIVE_INFINITY;
    streams: StreamEntry[] = [];
    fields: Record<string, unknown> = {};
    _isSimpleChild?: boolean;

    readonly trace: LogMethod = mkLogEmitter(TRACE);
    readonly debug: LogMethod = mkLogEmitter(DEBUG);
    readonly info: LogMethod = mkLogEmitter(INFO);
    readonly warn: LogMethod = mkLogEmitter(WARN);
    readonly error: LogMethod = mkLogEmitter(ERROR);
    readonly fatal: LogMethod = mkLogEmitter(FATAL);

    constructor(options: LoggerOptions);
    constructor(parent: Logger, childOptions?: ChildLoggerOptions, childSimple?: boolean);
    constructor(
        optionsOrParent: LoggerOptions | Logger,
        childOptions?: ChildLoggerOptions,
        childSimple?: boolean
    ) {
        super();

        let parent: Logger | undefined;
        let opts: LoggerOptions | ChildLoggerOptions;

        if (childOptions !== undefined) {
            // Called as: new Logger(parent, childOptions, simple)
            if (!(optionsOrParent instanceof Logger)) {
                throw new TypeError('invalid Logger creation: do not pass a second arg');
            }
            parent = optionsOrParent;
            opts = childOptions;
        } else {
            opts = optionsOrParent as LoggerOptions;
        }

        if (!opts || typeof opts !== 'object') {
            throw new TypeError('options (object) is required');
        }
        if (!parent) {
            if (!(opts as LoggerOptions).name) {
                throw new TypeError('options.name (string) is required');
            }
        } else {
            if ((opts as Record<string, unknown>).name) {
                throw new TypeError('invalid options.name: child cannot set logger name');
            }
        }
        if (opts.stream && opts.streams) {
            throw new TypeError('cannot mix "streams" and "stream" options');
        }
        if (opts.streams !== undefined && !Array.isArray(opts.streams)) {
            throw new TypeError('invalid options.streams: must be an array');
        }

        // Fast path for simple child creation (fields-only, no config options).
        if (parent && childSimple) {
            this._isSimpleChild = true;
            this._level = parent._level;
            this.streams = parent.streams;
            this.fields = { ...parent.fields, ...opts };
            return;
        }

        // Initialize from parent or start fresh.
        if (parent) {
            this._level = parent._level;
            this.streams = parent.streams.map(s => ({ ...s, closeOnExit: false }));
            this.fields = { ...parent.fields };
            if (opts.level !== undefined) {
                this._setLevel(opts.level);
            }
        }

        // Handle stream config options.
        if (opts.stream) {
            this._addStream({ stream: opts.stream, closeOnExit: false, level: opts.level });
        } else if (opts.streams) {
            for (const s of opts.streams) {
                this._addStream(s, opts.level);
            }
        } else if (!parent) {
            this._addStream({ stream: process.stdout, closeOnExit: false, level: opts.level });
        }

        // Set default fields on every record (excluding config keys).
        const { stream: _s, streams: _ss, level: _l, ...restFields } = opts as LoggerOptions;
        if (!restFields.hostname && !this.fields.hostname) {
            restFields.hostname = os.hostname();
        }
        if (!restFields.pid) {
            restFields.pid = process.pid;
        }
        Object.assign(this.fields, restFields);
    }

    /** Returns the current log level (lowest level across all streams). */
    level(): number {
        return this._level;
    }

    /** Sets the log level on all streams. */
    _setLevel(value: number | LogLevelName): void {
        const newLevel = resolveLevel(value);
        for (const s of this.streams) {
            s.level = newLevel;
        }
        this._level = newLevel;
    }

    /** Adds a writable stream to this logger. */
    _addStream(s: StreamSpec, defaultLevel?: number | LogLevelName): void {
        const resolvedLevel = s.level !== undefined
            ? resolveLevel(s.level)
            : resolveLevel(defaultLevel ?? INFO);

        if (resolvedLevel < this._level) {
            this._level = resolvedLevel;
        }

        assert.ok(isWritable(s.stream), `"stream" stream is not writable: ${inspect(s.stream)}`);

        this.streams.push({
            stream: s.stream!,
            level: resolvedLevel,
            closeOnExit: s.closeOnExit ?? false,
        });
    }

    /**
     * Create a child logger with additional bound fields.
     *
     * @param options Fields (and optional config) to add to every record.
     * @param simple Assert that `options` only adds fields (fast path).
     */
    child(options: ChildLoggerOptions = {}, simple?: boolean): Logger {
        return new Logger(this, options, simple);
    }

    /** Emit a log record to all streams at or below the record's level. */
    _emit(rec: LogRecord): string {
        const str = JSON.stringify(rec) + os.EOL;
        const { level } = rec;
        for (const s of this.streams) {
            if (s.level <= level) {
                s.stream.write(str);
            }
        }
        return str;
    }
}


//---- Exports

export function createLogger(options: LoggerOptions): Logger {
    return new Logger(options);
}

export const VERSION: string = pkg.version;
export { LOG_VERSION };
