/**
 * Copyright (c) 2017 Trent Mick.
 * Copyright (c) 2017 Joyent Inc.
 *
 * The bunyan logging library for node.js.
 * Minimal console-only version: createLogger, child loggers, JSON to stdout.
 */

/*
 * Bunyan log format version. This becomes the 'v' field on all log records.
 * This will be incremented if there is any backward incompatible change to
 * the log record format. Details will be in 'CHANGES.md' (the change log).
 */
var LOG_VERSION = 0;

var os = require('os');
var util = require('util');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var stream = require('stream');

var format = util.format;


//---- Internal support stuff

/**
 * A shallow copy of an object. Bunyan logging attempts to never cause
 * exceptions, so this function attempts to handle non-objects gracefully.
 */
function objCopy(obj) {
    if (obj == null) {  // null or undefined
        return obj;
    } else if (Array.isArray(obj)) {
        return obj.slice();
    } else if (typeof (obj) === 'object') {
        var copy = {};
        Object.keys(obj).forEach(function (k) {
            copy[k] = obj[k];
        });
        return copy;
    } else {
        return obj;
    }
}

function isWritable(obj) {
    if (obj instanceof stream.Writable) {
        return true;
    }
    return typeof (obj.write) === 'function';
}


//---- Levels

var TRACE = 10;
var DEBUG = 20;
var INFO = 30;
var WARN = 40;
var ERROR = 50;
var FATAL = 60;

var levelFromName = {
    'trace': TRACE,
    'debug': DEBUG,
    'info': INFO,
    'warn': WARN,
    'error': ERROR,
    'fatal': FATAL
};
var nameFromLevel = {};
Object.keys(levelFromName).forEach(function (name) {
    nameFromLevel[levelFromName[name]] = name;
});

/**
 * Resolve a level number, name (upper or lowercase) to a level number value.
 *
 * @param nameOrNum {String|Number} A level name (case-insensitive) or positive
 *      integer level.
 * @api public
 */
function resolveLevel(nameOrNum) {
    var level;
    var type = typeof (nameOrNum);
    if (type === 'string') {
        level = levelFromName[nameOrNum.toLowerCase()];
        if (!level) {
            throw new Error(format('unknown level name: "%s"', nameOrNum));
        }
    } else if (type !== 'number') {
        throw new TypeError(format('cannot resolve level: invalid arg (%s):',
            type, nameOrNum));
    } else if (nameOrNum < 0 || Math.floor(nameOrNum) !== nameOrNum) {
        throw new TypeError(format('level is not a positive integer: %s',
            nameOrNum));
    } else {
        level = nameOrNum;
    }
    return level;
}


//---- Logger class

/**
 * Create a Logger instance.
 *
 * @param options {Object} At minimum this must include a 'name' string key.
 *   Configuration keys:
 *     - `stream`: a writable stream (defaults to process.stdout)
 *     - `streams`: array of stream objects with optional `level` per stream
 *     - `level`: log level name or number (default: 'info')
 *   All other keys become default fields on every log record.
 *
 * An alternative *internal* call signature is used for creating a child:
 *    new Logger(<parent logger>, <child options>[, <child opts are simple>]);
 */
function Logger(options, _childOptions, _childSimple) {
    if (!(this instanceof Logger)) {
        return new Logger(options, _childOptions);
    }

    // Input arg validation.
    var parent;
    if (_childOptions !== undefined) {
        parent = options;
        options = _childOptions;
        if (!(parent instanceof Logger)) {
            throw new TypeError(
                'invalid Logger creation: do not pass a second arg');
        }
    }
    if (!options) {
        throw new TypeError('options (object) is required');
    }
    if (!parent) {
        if (!options.name) {
            throw new TypeError('options.name (string) is required');
        }
    } else {
        if (options.name) {
            throw new TypeError(
                'invalid options.name: child cannot set logger name');
        }
    }
    if (options.stream && options.streams) {
        throw new TypeError('cannot mix "streams" and "stream" options');
    }
    if (options.streams && !Array.isArray(options.streams)) {
        throw new TypeError('invalid options.streams: must be an array');
    }

    EventEmitter.call(this);

    // Fast path for simple child creation.
    if (parent && _childSimple) {
        // `_isSimpleChild` is a signal to stream close handling that this child
        // owns none of its streams.
        this._isSimpleChild = true;

        this._level = parent._level;
        this.streams = parent.streams;
        var fields = this.fields = {};
        var parentFieldNames = Object.keys(parent.fields);
        for (var i = 0; i < parentFieldNames.length; i++) {
            var name = parentFieldNames[i];
            fields[name] = parent.fields[name];
        }
        var names = Object.keys(options);
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            fields[name] = options[name];
        }
        return;
    }

    // Start values.
    var self = this;
    if (parent) {
        this._level = parent._level;
        this.streams = [];
        for (var i = 0; i < parent.streams.length; i++) {
            var s = objCopy(parent.streams[i]);
            s.closeOnExit = false; // Don't own parent stream.
            this.streams.push(s);
        }
        this.fields = objCopy(parent.fields);
        if (options.level) {
            this._setLevel(options.level);
        }
    } else {
        this._level = Number.POSITIVE_INFINITY;
        this.streams = [];
        this.fields = {};
    }

    // Handle stream config options.
    if (options.stream) {
        self._addStream({
            stream: options.stream,
            closeOnExit: false,
            level: options.level
        });
    } else if (options.streams) {
        options.streams.forEach(function (s) {
            self._addStream(s, options.level);
        });
    } else if (!parent) {
        self._addStream({
            stream: process.stdout,
            closeOnExit: false,
            level: options.level
        });
    }

    // Fields.
    // These are the default fields for log records (minus the config
    // attributes removed below). To allow storing raw log records
    // (unrendered), `this.fields` must never be mutated. Create a copy for
    // any changes.
    var fields = objCopy(options);
    delete fields.stream;
    delete fields.level;
    delete fields.streams;
    if (!fields.hostname && !self.fields.hostname) {
        fields.hostname = os.hostname();
    }
    if (!fields.pid) {
        fields.pid = process.pid;
    }
    Object.keys(fields).forEach(function (k) {
        self.fields[k] = fields[k];
    });
}

util.inherits(Logger, EventEmitter);


/**
 * Get the current log level (lowest level of all streams).
 */
Logger.prototype.level = function level() {
    return this._level;
};


/**
 * Set the log level on all streams.
 */
Logger.prototype._setLevel = function _setLevel(value) {
    var newLevel = resolveLevel(value);
    var len = this.streams.length;
    for (var i = 0; i < len; i++) {
        this.streams[i].level = newLevel;
    }
    this._level = newLevel;
};


/**
 * Add a writable stream to this logger.
 *
 * @param s {Object} Stream config with fields:
 *    - `stream`: A writable stream (e.g. process.stdout).
 *    - `level`: Optional level for this stream. Falls back to `defaultLevel`.
 * @param defaultLevel {Number|String} Optional. Defaults to INFO.
 */
Logger.prototype._addStream = function _addStream(s, defaultLevel) {
    var self = this;
    if (defaultLevel === null || defaultLevel === undefined) {
        defaultLevel = INFO;
    }

    s = objCopy(s);

    if (s.level !== undefined) {
        s.level = resolveLevel(s.level);
    } else {
        s.level = resolveLevel(defaultLevel);
    }
    if (s.level < self._level) {
        self._level = s.level;
    }

    assert.ok(isWritable(s.stream),
        '"stream" stream is not writable: ' + util.inspect(s.stream));
    if (!s.closeOnExit) {
        s.closeOnExit = false;
    }

    self.streams.push(s);
};


/**
 * Create a child logger, typically to add a few log record fields.
 *
 * This can be useful when passing a logger to a sub-component, e.g.:
 *
 *    var reqLog = log.child({ requestId: req.id });
 *
 * @param options {Object} Fields to add to all records from this child.
 * @param simple {Boolean} Optional. Set to true to assert that `options`
 *    only adds fields (no config). This is a fast path for frequent child
 *    creation.
 */
Logger.prototype.child = function (options, simple) {
    return new (this.constructor)(this, options || {}, simple);
};


/**
 * Emit a log record to all streams at or below the record's level.
 */
Logger.prototype._emit = function (rec) {
    var str = JSON.stringify(rec) + os.EOL;
    var level = rec.level;
    for (var i = 0; i < this.streams.length; i++) {
        var s = this.streams[i];
        if (s.level <= level) {
            s.stream.write(str);
        }
    }
    return str;
};


/**
 * Build a record object suitable for emitting from the arguments
 * provided to a log emitter.
 */
function mkRecord(log, minLevel, args) {
    var fields, msgArgs;
    if (args[0] instanceof Error) {
        // `log.<level>(err, ...)`
        var err = args[0];
        fields = {
            err: {
                message: err.message,
                name: err.name,
                stack: err.stack,
                code: err.code,
                signal: err.signal
            }
        };
        if (args.length === 1) {
            msgArgs = [fields.err.message];
        } else {
            msgArgs = args.slice(1);
        }
    } else if (typeof (args[0]) !== 'object' || Array.isArray(args[0])) {
        // `log.<level>(msg, ...)`
        fields = null;
        msgArgs = args.slice();
    } else if (Buffer.isBuffer(args[0])) {  // `log.<level>(buf, ...)`
        // Almost certainly an error, show `inspect(buf)`. See bunyan issue #35.
        fields = null;
        msgArgs = args.slice();
        msgArgs[0] = util.inspect(msgArgs[0]);
    } else {  // `log.<level>(fields, msg, ...)`
        fields = args[0];
        if (fields && args.length === 1 && fields.err &&
            fields.err instanceof Error)
        {
            msgArgs = [fields.err.message];
        } else {
            msgArgs = args.slice(1);
        }
    }

    // Build up the record object.
    var rec = objCopy(log.fields);
    rec.level = minLevel;
    if (fields) {
        var recFields = objCopy(fields);
        Object.keys(recFields).forEach(function (k) {
            rec[k] = recFields[k];
        });
    }
    rec.msg = format.apply(log, msgArgs);
    if (!rec.time) {
        rec.time = (new Date());
    }
    rec.v = LOG_VERSION;

    return rec;
}


/**
 * Build a log emitter function for level minLevel. I.e. this is the
 * creator of `log.info`, `log.error`, etc.
 */
function mkLogEmitter(minLevel) {
    return function () {
        if (arguments.length === 0) {   // `log.<level>()`
            return (this._level <= minLevel);
        }

        if (this._level <= minLevel) {
            var msgArgs = new Array(arguments.length);
            for (var i = 0; i < msgArgs.length; ++i) {
                msgArgs[i] = arguments[i];
            }
            var rec = mkRecord(this, minLevel, msgArgs);
            this._emit(rec);
        }
    };
}


/**
 * The functions below log a record at a specific level.
 *
 * Usages:
 *    log.<level>()  -> boolean is-<level>-enabled
 *    log.<level>(<Error> err, [<string> msg, ...])
 *    log.<level>(<string> msg, ...)
 *    log.<level>(<object> fields, <string> msg, ...)
 *
 * where <level> is the lowercase version of the log level. E.g.:
 *
 *    log.info()
 *    log.info('hello %s', 'world')
 *    log.error(err, 'request failed')
 *    log.warn({ req }, 'slow request')
 */
Logger.prototype.trace = mkLogEmitter(TRACE);
Logger.prototype.debug = mkLogEmitter(DEBUG);
Logger.prototype.info = mkLogEmitter(INFO);
Logger.prototype.warn = mkLogEmitter(WARN);
Logger.prototype.error = mkLogEmitter(ERROR);
Logger.prototype.fatal = mkLogEmitter(FATAL);


//---- Exports

module.exports = Logger;

module.exports.TRACE = TRACE;
module.exports.DEBUG = DEBUG;
module.exports.INFO = INFO;
module.exports.WARN = WARN;
module.exports.ERROR = ERROR;
module.exports.FATAL = FATAL;
module.exports.resolveLevel = resolveLevel;
module.exports.levelFromName = levelFromName;
module.exports.nameFromLevel = nameFromLevel;

module.exports.VERSION = require('../package.json').version;
module.exports.LOG_VERSION = LOG_VERSION;

module.exports.createLogger = function createLogger(options) {
    return new Logger(options);
};
