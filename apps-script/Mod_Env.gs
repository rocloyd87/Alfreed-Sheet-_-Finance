/**
 * Environment detection utilities for Alfred 5.0.
 * Determines active environment (dev/stage/prod) and toggles feature flags.
 */
var Mod_Env = (function () {
  'use strict';

  var CACHE_NAMESPACE = 'env';
  var CACHE_KEY = 'active';
  var cachedEnv = null;

  function detectEnvironment(forceReload) {
    if (!forceReload && cachedEnv) {
      return cachedEnv;
    }

    var cached = !forceReload ? Mod_Cache.get(CACHE_NAMESPACE, CACHE_KEY) : null;
    if (cached) {
      cachedEnv = cached;
      return cachedEnv;
    }

    Logs.logEvent('INFO', 'Mod_Env', 'Env.detectEnvironment invoked', {
      forceReload: !!forceReload
    });

    var descriptor = {
      name: 'prod',
      sheetId: null,
      featureFlags: {},
      source: {
        properties: false,
        sheet: false
      }
    };

    mergeFromProperties_(descriptor);
    mergeFromSheet_(descriptor);

    cachedEnv = descriptor;
    Mod_Cache.set(CACHE_NAMESPACE, CACHE_KEY, descriptor, 300);

    return cachedEnv;
  }

  function mergeFromProperties_(descriptor) {
    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      return;
    }

    try {
      var properties = PropertiesService.getScriptProperties().getProperties();
      if (!properties) {
        return;
      }
      descriptor.source.properties = true;

      if (properties.ALFRED_ENV_NAME) {
        descriptor.name = properties.ALFRED_ENV_NAME;
      }
      if (properties.ALFRED_PRIMARY_SHEET_ID) {
        descriptor.sheetId = properties.ALFRED_PRIMARY_SHEET_ID;
      }
      if (properties.ALFRED_FEATURE_FLAGS) {
        try {
          descriptor.featureFlags = JSON.parse(properties.ALFRED_FEATURE_FLAGS);
        } catch (err) {
          Logs.logEvent('WARN', 'Mod_Env', 'Failed to parse ALFRED_FEATURE_FLAGS', {
            error: err.message
          });
        }
      }
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Env', 'Environment detection via properties failed', {
        error: err.message
      });
    }
  }

  function mergeFromSheet_(descriptor) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return;
    }

    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      descriptor.sheetId = descriptor.sheetId || ss.getId();
      var metaSheet = ss.getSheetByName('Config');
      if (!metaSheet) {
        return;
      }

      var values = metaSheet.getDataRange().getValues();
      if (!values || values.length < 2) {
        return;
      }

      descriptor.source.sheet = true;

      for (var i = 1; i < values.length; i++) {
        var key = values[i][0];
        if (!key) {
          continue;
        }
        var value = values[i][1];
        if (key === 'env.name' && value) {
          descriptor.name = value.toString();
        }
        if (key === 'env.featureFlags' && value) {
          try {
            descriptor.featureFlags = typeof value === 'string' ? JSON.parse(value) : value;
          } catch (err) {
            Logs.logEvent('WARN', 'Mod_Env', 'Failed to parse feature flags from Config sheet', {
              error: err.message
            });
          }
        }
      }
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Env', 'Environment detection via sheet failed', {
        error: err.message
      });
    }
  }

  return {
    detectEnvironment: detectEnvironment
  };
})();
