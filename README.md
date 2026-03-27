# bunyan

> This is a TypeScript rewrite and feature-reduced fork of the original
> [node-bunyan](https://github.com/trentm/node-bunyan) by
> [Trent Mick](https://github.com/trentm). All credit for the library's design,
> log format, and CLI tool belongs to him. See [Acknowledgments](#acknowledgments).

A minimal, fast JSON logging library for Node.js services, and a `bunyan` CLI
tool for pretty-printing those logs.

```js
const { createLogger } = require('bunyan');
const log = createLogger({ name: 'myapp' });
log.info('server started');
log.warn({ port: 8080 }, 'listening');
```

Output (one JSON line per record, written to `process.stdout`):

```json
{"name":"myapp","hostname":"host","pid":1234,"level":30,"msg":"server started","time":"2026-03-27T12:00:00.000Z","v":0}
{"name":"myapp","hostname":"host","pid":1234,"level":40,"port":8080,"msg":"listening","time":"2026-03-27T12:00:00.001Z","v":0}
```

Pretty-printed via the CLI:

```text
[2026-03-27T12:00:00.000Z]  INFO: myapp/1234 on host: server started
[2026-03-27T12:00:00.001Z]  WARN: myapp/1234 on host: listening (port=8080)
```


## Installation

```sh
npm install bunyan
```

For the CLI on your `PATH`:

```sh
npm install -g bunyan
```


## Features

- Structured JSON output to `stdout` — one record per line
- Six log levels with built-in level filtering
- Child loggers with bound fields
- `bunyan` CLI for pretty-printing and filtering logs
- Written in TypeScript; ships with type declarations
- Zero required runtime dependencies


## API

### `createLogger(options)`

Creates a root logger.

```js
const { createLogger } = require('bunyan');

const log = createLogger({
    name: 'myapp',          // Required. Included in every record.
    level: 'info',          // Optional. Default: 'info'. Name or numeric value.
    stream: process.stdout, // Optional. A writable stream. Cannot combine with `streams`.
    streams: [              // Optional. Array of stream specs. Cannot combine with `stream`.
        { stream: process.stdout, level: 'info' },
        { stream: process.stderr, level: 'error' },
    ],
    // Any other fields are included in every log record.
    component: 'api',
});
```

If neither `stream` nor `streams` is provided, the logger writes to
`process.stdout` at the configured level.

### Log methods

Each level has a corresponding method: `trace`, `debug`, `info`, `warn`,
`error`, `fatal`.

```js
// Returns a boolean — is this level enabled?
log.info();

// Log a message string (printf-style formatting via util.format).
log.info('request received');
log.info('user %s logged in', userId);

// Log with extra fields merged into the record.
log.info({ requestId: 'abc123' }, 'request received');

// Log an Error — adds an `err` field with message, name, stack, code.
log.error(err);
log.error(err, 'failed to connect to %s', host);
```

### Level constants

```js
const { TRACE, DEBUG, INFO, WARN, ERROR, FATAL } = require('bunyan');
// 10      20     30    40    50     60
```

### `logger.level()`

Returns the current effective log level (the lowest level across all streams).

```js
log.level(); // e.g. 30 for INFO
```

### `logger.child(fields)`

Creates a child logger that inherits streams and fields, adding new bound
fields to every record it produces.

```js
const child = log.child({ requestId: req.id, userId: req.user.id });
child.info('handling request');
child.error(err, 'request failed');
```

Child loggers can themselves be further childed:

```js
const grandchild = child.child({ step: 'validation' });
```


## Log Record Fields

Every record includes these core fields automatically:

| Field      | Type   | Description                              |
|------------|--------|------------------------------------------|
| `v`        | number | Bunyan log format version (always `0`)   |
| `name`     | string | Logger name (from `createLogger`)        |
| `hostname` | string | `os.hostname()` (overridable)            |
| `pid`      | number | `process.pid` (overridable)              |
| `level`    | number | Numeric log level                        |
| `time`     | string | ISO 8601 timestamp                       |
| `msg`      | string | Log message                              |

Any additional fields passed to `createLogger` options or to `log.child` are
also included in every record.


## Log Levels

| Name    | Value | Meaning                                     |
|---------|-------|---------------------------------------------|
| `trace` | 10    | Very detailed; usually only in development  |
| `debug` | 20    | Debug information                           |
| `info`  | 30    | Normal operational messages (default)       |
| `warn`  | 40    | Warning conditions                          |
| `error` | 50    | Error conditions                            |
| `fatal` | 60    | Service/application is going down           |


## CLI Tool

The `bunyan` CLI reads newline-delimited JSON log lines and pretty-prints them.

```sh
# Pretty-print a log file
bunyan app.log

# Filter to warn and above
bunyan -l warn app.log

# Filter by a JavaScript condition
bunyan -c 'this.level === ERROR && this.userId === "abc"' app.log

# Pipe from a running service
node app.js | bunyan

# Output formats: long (default), short, simple, json, bunyan
bunyan -o short app.log

# Display timestamps in local time (requires optional `moment` dependency)
bunyan -L app.log

# Read gzip-compressed logs
bunyan app.log.gz
```

Run `bunyan --help` for the full option list.


## TypeScript

The package ships with `.d.ts` declarations. Exported types:

```ts
import {
    createLogger,
    Logger,
    LoggerOptions,
    ChildLoggerOptions,
    LogMethod,
    LogLevelName,
    StreamLike,
    StreamSpec,
    TRACE, DEBUG, INFO, WARN, ERROR, FATAL,
    levelFromName,
    nameFromLevel,
    resolveLevel,
    VERSION,
} from 'bunyan';
```


## Requirements

- Node.js >= 22.0.0


## Acknowledgments

bunyan was created by [Trent Mick](https://github.com/trentm) at Joyent. The
structured JSON log format, the six-level API, child loggers, and the `bunyan`
CLI pretty-printer are all his work. This fork strips the library down to a
console-only TypeScript implementation for environments where simplicity and
type safety matter more than the full feature set. The original project lives at
[trentm/node-bunyan](https://github.com/trentm/node-bunyan).


## License

MIT — Copyright (c) Trent Mick and Joyent Inc.
