/**
 * Structured logging utilities for Alfred 5.0.
 */
var Logs = (function () {
  'use strict';

  /**
   * Logs an event with structured context.
   * @param {string} level - Log level (INFO, WARN, ERROR).
   * @param {string} module - Module identifier.
   * @param {string} message - Log message.
   * @param {Object=} context - Optional structured context.
   */
  var LOG_SHEET_NAME = '_Logs';

  function logEvent(level, module, message, context) {
    var entry = buildEntry_(level, module, message, context);

    try {
      console.log(JSON.stringify(entry));
    } catch (consoleErr) {
      // Swallow console errors to avoid cascading failures.
    }

    try {
      appendToSheet_(entry);
    } catch (sheetErr) {
      try {
        console.error('Log sheet append failed', sheetErr);
      } catch (ignored) {
        // ignore secondary failures
      }
    }

    return entry;
  }

  /**
   * Wraps a function call with trace logging.
   * @param {Function} fn - Function to execute.
   * @return {*} Result of the function call.
   */
  function withTrace(fn, metadata) {
    var trace = (typeof Main !== 'undefined' && typeof Main.createTraceContext === 'function')
      ? Main.createTraceContext(metadata)
      : createFallbackTrace_(metadata);
    var start = Date.now();
    logEvent('INFO', trace.module || 'Mod_Core', 'Trace start', {
      traceId: trace.traceId,
      metadata: scrubContext_(metadata)
    });
    try {
      var result = fn(trace);
      logEvent('INFO', trace.module || 'Mod_Core', 'Trace success', {
        traceId: trace.traceId,
        elapsedMs: Date.now() - start
      });
      return result;
    } catch (err) {
      logEvent('ERROR', trace.module || 'Mod_Core', 'Trace error', {
        traceId: trace.traceId,
        elapsedMs: Date.now() - start,
        error: formatError_(err)
      });
      throw err;
    } finally {
      logEvent('INFO', trace.module || 'Mod_Core', 'Trace end', {
        traceId: trace.traceId,
        elapsedMs: Date.now() - start
      });
    }
  }

  function buildEntry_(level, module, message, context) {
    return {
      timestamp: new Date().toISOString(),
      level: level,
      module: module,
      message: message,
      context: scrubContext_(context)
    };
  }

  function scrubContext_(context) {
    if (!context) {
      return null;
    }

    if (typeof Mod_Security !== 'undefined' && typeof Mod_Security.redactPII === 'function') {
      try {
        return Mod_Security.redactPII(context);
      } catch (err) {
        try {
          console.warn('Security redaction failed', err.message);
        } catch (consoleErr) {
          // ignore secondary failures
        }
      }
    }

    if (typeof context !== 'object') {
      return context;
    }

    var clone = {};
    Object.keys(context).forEach(function (key) {
      clone[key] = maskValue_(context[key]);
    });
    return clone;
  }

  function maskValue_(value) {
    if (value === null || typeof value === 'undefined') {
      return value;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value)) {
      return value.map(maskValue_);
    }

    if (typeof value === 'object') {
      var nested = {};
      Object.keys(value).forEach(function (key) {
        nested[key] = maskValue_(value[key]);
      });
      return nested;
    }

    if (typeof value === 'string') {
      if (value.length > 64) {
        return value.slice(0, 61) + '…';
      }
      if (/@/.test(value)) {
        return value.replace(/(^.).*(@.*$)/, '$1***$2');
      }
      if (/\d{6,}/.test(value)) {
        return value.replace(/\d/g, '*');
      }
      return value;
    }

    return value;
  }

  function appendToSheet_(entry) {
    if (typeof SpreadsheetApp === 'undefined') {
      return;
    }

    var sheet = getLogSheet_();
    if (!sheet) {
      return;
    }

    sheet.appendRow([
      entry.timestamp,
      entry.level,
      entry.module,
      entry.message,
      entry.context ? JSON.stringify(entry.context) : ''
    ]);
  }

  function getLogSheet_() {
    var ss;
    if (typeof SpreadsheetApp.getActiveSpreadsheet === 'function') {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } else if (typeof SpreadsheetApp.getActive === 'function') {
      ss = SpreadsheetApp.getActive();
    }
    if (!ss) {
      return null;
    }

    var sheet = ss.getSheetByName(LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(LOG_SHEET_NAME);
      sheet.getRange(1, 1, 1, 5).setValues([
        ['Timestamp', 'Level', 'Module', 'Message', 'Context']
      ]);
    }
    return sheet;
  }

  function formatError_(err) {
    if (!err) {
      return null;
    }

    return {
      message: err.message || err.toString(),
      name: err.name || 'Error',
      stack: err.stack || null
    };
  }

  function createFallbackTrace_(metadata) {
    var base = {
      traceId: 'trace-' + Math.random().toString(36).slice(2) + '-' + Date.now(),
      timestamp: new Date().toISOString(),
      module: 'Mod_Core'
    };
    if (metadata) {
      Object.keys(metadata).forEach(function (key) {
        base[key] = metadata[key];
      });
    }
    return base;
  }

  return {
    logEvent: logEvent,
    withTrace: withTrace
  };
})();
