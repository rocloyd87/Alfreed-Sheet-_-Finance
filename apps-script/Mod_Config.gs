/**
 * Configuration loader with caching and validation.
 */
var Mod_Config = (function () {
  'use strict';

  var CACHE_NAMESPACE = 'config';
  var CACHE_KEY = 'active';
  var REQUIRED_KEYS = ['baseCurrency', 'timezone', 'transactionsSheet'];
  var cachedConfig = null;

  function load(forceReload) {
    if (!forceReload && cachedConfig) {
      return cachedConfig;
    }

    var cached = !forceReload ? Mod_Cache.get(CACHE_NAMESPACE, CACHE_KEY) : null;
    if (cached) {
      cachedConfig = cached;
      return cachedConfig;
    }

    Logs.logEvent('INFO', 'Mod_Config', 'Config.load invoked', {
      forceReload: !!forceReload
    });

    var config = {
      loadedAt: new Date().toISOString(),
      source: {
        properties: false,
        sheet: false
      }
    };

    mergeProperties_(config);
    mergeSheetValues_(config);

    validate_(config);

    cachedConfig = config;
    Mod_Cache.set(CACHE_NAMESPACE, CACHE_KEY, config, 300);

    return cachedConfig;
  }

  function mergeProperties_(config) {
    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      return;
    }

    try {
      var properties = PropertiesService.getScriptProperties().getProperties();
      if (!properties) {
        return;
      }
      config.source.properties = true;

      Object.keys(properties).forEach(function (key) {
        if (key.indexOf('ALFRED_CONFIG_') === 0) {
          var normalizedKey = key.replace('ALFRED_CONFIG_', '').toLowerCase();
          config[normalizedKey] = properties[key];
        }
      });

      if (properties.ALFRED_CONFIG_JSON) {
        try {
          var json = JSON.parse(properties.ALFRED_CONFIG_JSON);
          Object.keys(json).forEach(function (k) {
            config[k] = json[k];
          });
        } catch (err) {
          Logs.logEvent('WARN', 'Mod_Config', 'Failed to parse ALFRED_CONFIG_JSON', {
            error: err.message
          });
        }
      }
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Config', 'Config.load properties merge failed', {
        error: err.message
      });
    }
  }

  function mergeSheetValues_(config) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return;
    }

    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
      if (!sheet) {
        return;
      }

      var range = sheet.getDataRange();
      var values = range.getValues();
      if (!values || values.length < 2) {
        return;
      }

      config.source.sheet = true;
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row || !row[0]) {
          continue;
        }
        var key = row[0].toString().trim();
        var value = row[1];
        if (!key) {
          continue;
        }
        config[key] = value;
      }
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Config', 'Config.load sheet merge failed', {
        error: err.message
      });
    }
  }

  function validate_(config) {
    var missing = [];
    REQUIRED_KEYS.forEach(function (key) {
      if (!config.hasOwnProperty(key) || config[key] === '') {
        missing.push(key);
      }
    });

    if (missing.length) {
      Logs.logEvent('WARN', 'Mod_Config', 'Config validation warnings', {
        missing: missing
      });
    }

    if (!config.baseCurrency) {
      config.baseCurrency = 'USD';
    }

    if (!config.timezone) {
      config.timezone = 'UTC';
    }

    if (!config.transactionsSheet) {
      config.transactionsSheet = 'Transactions';
    }

    if (!config.statementsSheet) {
      config.statementsSheet = 'Statements';
    }

    if (!config.reconcileExceptionsSheet) {
      config.reconcileExceptionsSheet = 'Reconcile_Exceptions';
    }

    if (!config.reconcileMatchesSheet) {
      config.reconcileMatchesSheet = 'Reconcile_Matches';
    }

    if (!config.debtsSheet) {
      config.debtsSheet = 'Debts';
    }

    if (!config.debtAmortizationSheet) {
      config.debtAmortizationSheet = 'Debt_Amortization';
    }

    if (!config.debtSummarySheet) {
      config.debtSummarySheet = 'Debt_Strategy';
    }

    if (!config.holdingsSheet) {
      config.holdingsSheet = 'Holdings';
    }

    if (!config.holdingsAllocationsSheet) {
      config.holdingsAllocationsSheet = 'Holdings_Allocations';
    }

    if (!config.netWorthHistorySheet) {
      config.netWorthHistorySheet = 'NetWorth_History';
    }

    if (!config.securityRolesSheet) {
      config.securityRolesSheet = 'Security_Roles';
    }

    if (!config.securityAccessLogSheet) {
      config.securityAccessLogSheet = 'Security_Access_Log';
    }
  }

  return {
    load: load
  };
})();
