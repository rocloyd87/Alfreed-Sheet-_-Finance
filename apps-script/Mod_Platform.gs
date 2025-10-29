/**
 * Platform services bundle: cache, locks, metrics, and general utilities.
 * Consolidated to reduce script count while keeping critical modules isolated.
 */
var Mod_Platform = (function () {
  'use strict';

  var METRICS_SHEET_NAME = '_Metrics';
  var MAX_TTL_SECONDS = 21600;

  function cacheGet(namespace, key) {
    if (!namespace || !key) {
      return null;
    }

    var cacheKey = buildCacheKey_(namespace, key);
    var raw;

    try {
      if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
        raw = CacheService.getScriptCache().get(cacheKey);
      }
    } catch (err) {
      safeLog_('WARN', 'Cache.get failed', { namespace: namespace, key: key, error: err.message });
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      safeLog_('WARN', 'Cache.get parse error', { namespace: namespace, key: key, error: parseErr.message });
      return null;
    }
  }

  function cacheSet(namespace, key, value, ttlSeconds) {
    if (!namespace || !key) {
      return;
    }

    var cacheKey = buildCacheKey_(namespace, key);
    var ttl = Math.max(5, Math.min(ttlSeconds || MAX_TTL_SECONDS, MAX_TTL_SECONDS));

    try {
      var payload = JSON.stringify(value);
      if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
        CacheService.getScriptCache().put(cacheKey, payload, ttl);
      }
    } catch (err) {
      safeLog_('WARN', 'Cache.set failed', { namespace: namespace, key: key, error: err.message });
    }
  }

  function cacheInvalidate(namespace, key) {
    if (!namespace) {
      return;
    }

    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) {
      return;
    }

    var cache = CacheService.getScriptCache();
    if (key) {
      cache.remove(buildCacheKey_(namespace, key));
      return;
    }

    cache.removeAll();
  }

  function withLock(key, timeoutMs, fn) {
    if (typeof fn !== 'function') {
      throw new Error('withLock requires a function to execute');
    }

    var waitMillis = Math.max(50, timeoutMs || 5000);
    var lock = getLock_(key);
    var acquired = false;

    try {
      if (lock) {
        acquired = lock.tryLock(waitMillis);
        if (!acquired) {
          safeLog_('WARN', 'Lock acquisition timed out', { key: key, timeoutMs: waitMillis });
          throw new Error('Lock acquisition timed out for key ' + key);
        }
      }

      return fn();
    } catch (err) {
      safeLog_('ERROR', 'Lock execution failed', { key: key, error: err.message });
      throw err;
    } finally {
      if (acquired && lock) {
        try {
          lock.releaseLock();
        } catch (releaseErr) {
          safeLog_('WARN', 'Failed to release lock', { key: key, error: releaseErr.message });
        }
      }
    }
  }

  function recordMetric(metricName, value, tags) {
    if (!metricName) {
      return;
    }

    var entry = {
      recordedAt: new Date().toISOString(),
      metric: metricName,
      value: typeof value === 'number' ? value : 1,
      tags: tags || {}
    };

    try {
      appendMetric_(entry);
    } catch (err) {
      safeLog_('WARN', 'Failed to persist metric', { metricName: metricName, error: err.message });
    }

    try {
      console.log('[Metric]', JSON.stringify(entry));
    } catch (consoleErr) {
      // ignore console errors
    }
  }

  function chunkedProcess(items, chunkSize, handler, options) {
    options = options || {};
    if (!items || !items.length) {
      return 0;
    }
    if (typeof handler !== 'function') {
      throw new Error('chunkedProcess requires a handler function');
    }

    var size = Math.max(1, chunkSize || 50);
    var processed = 0;
    var total = items.length;
    var sleepMs = options.sleepMs || 0;

    for (var offset = 0; offset < total; offset += size) {
      var slice = items.slice(offset, offset + size);
      var metadata = {
        chunkIndex: Math.floor(offset / size),
        chunkSize: slice.length,
        total: total,
        processed: processed
      };

      try {
        handler(slice, metadata);
        processed += slice.length;
      } catch (err) {
        safeLog_('ERROR', 'Chunk handler failed', { offset: offset, chunkSize: slice.length, error: err.message });
        if (!options.continueOnError) {
          throw err;
        }
      }

      if (sleepMs > 0 && typeof Utilities !== 'undefined' && Utilities.sleep) {
        Utilities.sleep(sleepMs);
      }
    }

    return processed;
  }

  function safeLog_(level, message, context) {
    if (typeof Logs !== 'undefined' && Logs.logEvent) {
      Logs.logEvent(level, 'Mod_Platform', message, context || {});
    }
  }

  function buildCacheKey_(namespace, key) {
    return ['ALFRED', namespace, key].join('::');
  }

  function getLock_(key) {
    if (typeof LockService === 'undefined' || !LockService.getScriptLock) {
      safeLog_('WARN', 'LockService unavailable, executing without lock', { key: key });
      return null;
    }

    try {
      return LockService.getScriptLock();
    } catch (err) {
      safeLog_('WARN', 'Failed to obtain script lock', { key: key, error: err.message });
      return null;
    }
  }

  function appendMetric_(entry) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return;
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(METRICS_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(METRICS_SHEET_NAME);
      sheet.getRange(1, 1, 1, 4).setValues([[
        'RecordedAt', 'Metric', 'Value', 'Tags'
      ]]);
    }

    sheet.appendRow([
      entry.recordedAt,
      entry.metric,
      entry.value,
      JSON.stringify(entry.tags || {})
    ]);
  }

  return {
    cache: {
      get: cacheGet,
      set: cacheSet,
      invalidate: cacheInvalidate
    },
    locks: {
      withLock: withLock
    },
    metrics: {
      record: recordMetric
    },
    utils: {
      chunkedProcess: chunkedProcess
    }
  };
})();

var Mod_Cache = Mod_Platform.cache;
var Mod_Locks = Mod_Platform.locks;
var Mod_Metrics = Mod_Platform.metrics;
var Mod_Utils = Mod_Platform.utils;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Mod_Platform;
}
