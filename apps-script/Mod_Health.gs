/**
 * Health diagnostics and heartbeat module.
 */
var Mod_Health = (function () {
  'use strict';

  function checkAll() {
    Logs.logEvent('INFO', 'Mod_Health', 'Health.checkAll invoked');

    var checks = [];
    var status = 'OK';

    status = evaluateCheck_(checks, 'Mod_Schema', function () {
      return Mod_Schema.verifyAndMigrate({ dryRun: true });
    }, function (result) {
      return result.status;
    }, function (result) {
      return result;
    }, status);

    status = evaluateCheck_(checks, 'Mod_Env', function () {
      return Mod_Env.detectEnvironment();
    }, null, null, status);

    status = evaluateCheck_(checks, 'Mod_Config', function () {
      return Mod_Config.load();
    }, function (config) {
      return config && config.baseCurrency ? 'OK' : 'WARN';
    }, function (config) {
      return {
        timezone: config.timezone,
        baseCurrency: config.baseCurrency,
        transactionsSheet: config.transactionsSheet || null,
        source: config.source
      };
    }, status);

    if (typeof Mod_Reconcile !== 'undefined' && typeof Mod_Reconcile.healthProbe === 'function') {
      status = evaluateCheck_(checks, 'Mod_Reconcile', function () {
        return Mod_Reconcile.healthProbe();
      }, function (probe) {
        return probe && probe.ok === false ? 'WARN' : 'OK';
      }, function (probe) {
        return probe;
      }, status);
    }

    if (typeof Mod_Analytics !== 'undefined' && typeof Mod_Analytics.healthProbe === 'function') {
      status = evaluateCheck_(checks, 'Mod_Analytics', function () {
        return Mod_Analytics.healthProbe();
      }, function (probe) {
        return probe && probe.ok === false ? 'WARN' : 'OK';
      }, function (probe) {
        return probe;
      }, status);
    }

    if (typeof Mod_Debt !== 'undefined' && typeof Mod_Debt.healthProbe === 'function') {
      status = evaluateCheck_(checks, 'Mod_Debt', function () {
        return Mod_Debt.healthProbe();
      }, function (probe) {
        return probe && probe.ok === false ? 'WARN' : 'OK';
      }, function (probe) {
        return probe;
      }, status);
    }

    if (typeof Mod_Invest !== 'undefined' && typeof Mod_Invest.healthProbe === 'function') {
      status = evaluateCheck_(checks, 'Mod_Invest', function () {
        return Mod_Invest.healthProbe();
      }, function (probe) {
        return probe && probe.ok === false ? 'WARN' : 'OK';
      }, function (probe) {
        return probe;
      }, status);
    }

    if (typeof Mod_Security !== 'undefined' && typeof Mod_Security.healthProbe === 'function') {
      status = evaluateCheck_(checks, 'Mod_Security', function () {
        return Mod_Security.healthProbe();
      }, function (probe) {
        return probe && probe.ok === false ? 'WARN' : 'OK';
      }, function (probe) {
        return probe;
      }, status);
    }

    status = evaluateCheck_(checks, 'Heartbeat', fetchHeartbeat_, function (hb) {
      if (!hb || !hb.lastHeartbeat) {
        return 'WARN';
      }
      var elapsed = Date.now() - new Date(hb.lastHeartbeat).getTime();
      return elapsed > 1000 * 60 * 60 ? 'WARN' : 'OK';
    }, undefined, status);

    return {
      status: status,
      checkedAt: new Date().toISOString(),
      checks: checks
    };
  }

  function publishHeartbeat() {
    Logs.logEvent('INFO', 'Mod_Health', 'Health.publishHeartbeat invoked');

    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      return;
    }

    PropertiesService.getScriptProperties().setProperty('ALFRED_LAST_HEARTBEAT', new Date().toISOString());
  }

  function evaluateCheck_(checks, moduleName, fn, statusDeriver, detailDeriver, currentStatus) {
    currentStatus = currentStatus || 'OK';
    try {
      var result = fn();
      var derivedStatus = statusDeriver ? statusDeriver(result) : 'OK';
      checks.push({
        module: moduleName,
        status: derivedStatus,
        details: detailDeriver ? detailDeriver(result) : result
      });
      return rollUpStatus_(currentStatus, derivedStatus);
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Health', 'Module health check failed', {
        module: moduleName,
        error: err.message
      });
      checks.push({
        module: moduleName,
        status: 'ERROR',
        error: err.message
      });
      return 'ERROR';
    }
  }

  function fetchHeartbeat_() {
    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      return null;
    }
    var lastHeartbeat = PropertiesService.getScriptProperties().getProperty('ALFRED_LAST_HEARTBEAT');
    return {
      lastHeartbeat: lastHeartbeat
    };
  }

  function rollUpStatus_(current, next) {
    var normalizedNext = normalizeStatus_(next);
    if (current === 'ERROR' || normalizedNext === 'ERROR') {
      return 'ERROR';
    }
    if (current === 'WARN' || normalizedNext === 'WARN') {
      return 'WARN';
    }
    return 'OK';
  }

  function normalizeStatus_(status) {
    if (status === 'ERROR') {
      return 'ERROR';
    }
    if (status === 'UPDATED' || status === 'PENDING' || status === 'WARN') {
      return 'WARN';
    }
    return 'OK';
  }

  return {
    checkAll: checkAll,
    publishHeartbeat: publishHeartbeat
  };
})();
