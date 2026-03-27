# Changelog

## 4.0.0 (2026-03-27)

### Breaking Changes

This is a major rewrite of the library. The public API surface has been
intentionally reduced to the minimal subset needed for structured JSON console
logging (e.g. consumed by fluent-bit).

**Removed features:**

- `RotatingFileStream` — log rotation is no longer supported
- `RingBuffer` — in-memory ring buffer stream removed
- Serializers — `serializers` option, `addSerializers()`, and `stdSerializers`
  are gone; pass already-serialized fields directly
- Source tracking — the `src: true` option (call-site file/line/function) is
  removed
- DTrace integration — `dtrace-provider` probes are gone
- Cycle detection — `safe-json-stringify` / `safeCycles` support removed
- File stream type — the `type: 'file'` stream option is removed; pass a
  writable stream directly
- Raw stream type — the `type: 'raw'` stream option is removed; streams always
  receive a serialized JSON string
- Dynamic stream management — `addStream()`, `reopenFileStreams()`, `close()`
- Dynamic level management — `logger.level(newLevel)` and `logger.levels()` are
  removed; level is set at construction time only. `logger.level()` (no args)
  still returns the current level number.
- Browser / ConsoleRawStream support removed
- Optional dependency loading (`source-map-support`, `safe-json-stringify`,
  `dtrace-provider`) removed entirely

**Changed:**

- All output goes to `process.stdout` by default (a single stream only)
- Streams receive a serialized JSON string (not a raw record object)
- Converted to TypeScript — distributed as compiled CommonJS in `dist/`
- Named exports replace the old `module.exports = Logger` pattern:

  ```js
  const { createLogger, Logger, TRACE, DEBUG, INFO, WARN, ERROR, FATAL } = require('bunyan');
  ```

- `engines` requirement raised to Node.js `>=22.0.0`
- Optional dependency: `moment` retained for `-L` (local time) display in the
  `bunyan` CLI tool

**Kept:**

- `createLogger({ name, level, stream, streams })` factory
- Six log-level methods: `trace`, `debug`, `info`, `warn`, `error`, `fatal`
- `logger.child(fields)` for bound-field child loggers
- Level constants: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`
- `logger.level()` (read-only getter)
- `bunyan` CLI tool — pretty-printer and log filtering

---

## 2.0.5 (beta)

See upstream [trentm/node-bunyan](https://github.com/trentm/node-bunyan) for
history prior to this fork.
