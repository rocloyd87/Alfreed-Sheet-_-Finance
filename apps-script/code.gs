/**
 * Alfred 5.0 Orchestrator entry points.
 * Main orchestrates module registration, command routing, and trace context creation.
 */
var Main = (function () {
  'use strict';

  /**
   * Registers available modules and returns a registry map.
   * Note: auto-discovery of Mod_* namespaces is planned for a future release.
   */
  function registerModules() {
    var registry = {
      schema: typeof Mod_Schema !== 'undefined' ? Mod_Schema : null,
      env: typeof Mod_Env !== 'undefined' ? Mod_Env : null,
      config: typeof Mod_Config !== 'undefined' ? Mod_Config : null,
      health: typeof Mod_Health !== 'undefined' ? Mod_Health : null,
      logs: typeof Logs !== 'undefined' ? Logs : null,
      metrics: typeof Mod_Metrics !== 'undefined' ? Mod_Metrics : null,
      intake: typeof Mod_Intake !== 'undefined' ? Mod_Intake : null,
      categorize: typeof Mod_Categorize !== 'undefined' ? Mod_Categorize : null,
      sync: typeof Mod_Sync !== 'undefined' ? Mod_Sync : null,
      reconcile: typeof Mod_Reconcile !== 'undefined' ? Mod_Reconcile : null,
      analytics: typeof Mod_Analytics !== 'undefined' ? Mod_Analytics : null,
      debt: typeof Mod_Debt !== 'undefined' ? Mod_Debt : null,
      invest: typeof Mod_Invest !== 'undefined' ? Mod_Invest : null,
      dashboard: typeof Mod_Dashboard !== 'undefined' ? Mod_Dashboard : null,
      security: typeof Mod_Security !== 'undefined' ? Mod_Security : null,
      ui: typeof Mod_UI !== 'undefined' ? Mod_UI : null,
      platform: typeof Mod_Platform !== 'undefined' ? Mod_Platform : null,
      locks: typeof Mod_Locks !== 'undefined' ? Mod_Locks : null
    };

    if (typeof Logs !== 'undefined' && Logs.logEvent) {
      Logs.logEvent('INFO', 'Mod_Core', 'Modules registered', {
        available: Object.keys(registry).filter(function (key) {
          return !!registry[key];
        })
      });
    }

    return registry;
  }

  /**
   * Handles incoming commands routed from UI or triggers.
   * Applies LockService in future iterations to guard concurrent execution.
   *
   * @param {string} command - Command identifier (e.g., "@create", "@diagnostics").
   * @param {Object=} payload - Optional payload object.
   */
  function handleCommand(command, payload) {
    payload = payload || {};
    var normalizedCommand = (command || '').toString().trim();

    return Logs.withTrace(function (trace) {
      trace.command = normalizedCommand;
      var modules = registerModules();
      var env = modules.env ? modules.env.detectEnvironment() : null;
      var config = modules.config ? modules.config.load() : null;
      var start = Date.now();
      var result;
      var status = 'OK';

      try {
        result = executeWithLock_(modules, normalizedCommand, payload, function () {
          enforceSecurity_(modules.security, normalizedCommand, payload);
          switch (normalizedCommand) {
            case '@migrate':
              return modules.schema ? modules.schema.verifyAndMigrate(payload) : {
                status: 'ERROR',
                message: 'Schema module unavailable'
              };
            case '@diagnostics':
              return modules.health ? modules.health.checkAll() : {
                status: 'ERROR',
                message: 'Health module unavailable'
              };
            case '@import':
              return modules.intake ? modules.intake.importTransactions(payload) : {
                status: 'ERROR',
                message: 'Intake module unavailable'
              };
            case '@categorize':
              return modules.categorize ? modules.categorize.applyRules(payload) : {
                status: 'ERROR',
                message: 'Categorize module unavailable'
              };
            case '@sync':
            case '@commit':
              return modules.sync ? modules.sync.commitTransactions(payload) : {
                status: 'ERROR',
                message: 'Sync module unavailable'
              };
            case '@reconcile':
              return modules.reconcile ? modules.reconcile.reconcileStatement(payload) : {
                status: 'ERROR',
                message: 'Reconcile module unavailable'
              };
            case '@analytics':
              return modules.analytics ? modules.analytics.computeMetrics(payload) : {
                status: 'ERROR',
                message: 'Analytics module unavailable'
              };
            case '@debt':
              return modules.debt ? modules.debt.planPayoff(payload) : {
                status: 'ERROR',
                message: 'Debt module unavailable'
              };
            case '@invest':
              return modules.invest ? modules.invest.refreshPortfolio(payload) : {
                status: 'ERROR',
                message: 'Invest module unavailable'
              };
            case '@dashboard':
              return modules.dashboard ? modules.dashboard.buildPayload(payload) : {
                status: 'ERROR',
                message: 'Dashboard module unavailable'
              };
            case '@security':
              return modules.security ? modules.security.healthProbe(payload) : {
                status: 'ERROR',
                message: 'Security module unavailable'
              };
            case '@ui':
              return modules.ui ? modules.ui.render(payload) : {
                status: 'ERROR',
                message: 'UI module unavailable'
              };
            default:
              Logs.logEvent('WARN', 'Mod_Core', 'Unknown command received', {
                command: normalizedCommand
              });
              return {
                status: 'UNKNOWN_COMMAND',
                command: normalizedCommand
              };
          }
        });

        status = result && result.status ? result.status : 'OK';
        return result;
      } catch (err) {
        status = 'ERROR';
        Logs.logEvent('ERROR', 'Mod_Core', 'Command execution failed', {
          command: normalizedCommand,
          error: err.message
        });
        throw err;
      } finally {
        Logs.logEvent('INFO', 'Mod_Core', 'Command processed', {
          command: normalizedCommand,
          status: status,
          environment: env ? env.name : null
        });

        if (modules.metrics && modules.metrics.record) {
          var duration = Date.now() - start;
          modules.metrics.record('command.durationMs', duration, {
            command: normalizedCommand,
            environment: env ? env.name : 'unknown'
          });
          modules.metrics.record('command.status', status === 'ERROR' ? 0 : 1, {
            command: normalizedCommand,
            status: status
          });
        }
      }
    }, {
      module: 'Mod_Core',
      command: normalizedCommand,
      payloadSummary: summarizePayload_(payload),
      environment: env ? env.name : undefined,
      sheetId: env && env.sheetId ? env.sheetId : undefined,
      configLoaded: !!config
    });
  }

  /**
   * Creates a trace context for observability and logging.
   * Future implementations will include correlation IDs and elapsed time metrics.
   *
   * @param {Object=} overrides - Optional overrides for default trace properties.
   * @return {Object} Trace context object.
   */
  function createTraceContext(overrides) {
    var trace = {
      traceId: createTraceId_(),
      timestamp: new Date().toISOString(),
      module: 'Mod_Core'
    };

    if (overrides) {
      Object.keys(overrides).forEach(function (key) {
        trace[key] = overrides[key];
      });
    }

    return trace;
  }

  function createTraceId_() {
    try {
      if (typeof Utilities !== 'undefined' && Utilities.getUuid) {
        return Utilities.getUuid();
      }
    } catch (err) {
      // ignore and fall through to fallback implementation
    }
    return 'trace-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  }

  function summarizePayload_(payload) {
    if (!payload) {
      return null;
    }

    var keys = Object.keys(payload);
    if (!keys.length) {
      return {};
    }

    var summary = {};
    keys.slice(0, 5).forEach(function (key) {
      var value = payload[key];
      if (value === null || typeof value === 'undefined') {
        summary[key] = value;
      } else if (Array.isArray(value)) {
        summary[key] = '[array:' + value.length + ']';
      } else if (typeof value === 'object') {
        summary[key] = '[object]';
      } else if (typeof value === 'string') {
        summary[key] = value.length > 32 ? value.slice(0, 29) + '…' : value;
      } else {
        summary[key] = value;
      }
    });

    if (keys.length > 5) {
      summary._truncated = keys.length - 5;
    }

    return summary;
  }

  function executeWithLock_(modules, command, payload, executor) {
    if (modules.locks && typeof modules.locks.withLock === 'function') {
      return modules.locks.withLock('command::' + command, 20000, function () {
        return executor();
      });
    }
    return executor();
  }

  function enforceSecurity_(securityModule, command, payload) {
    if (!securityModule || typeof securityModule.enforceRole !== 'function') {
      return;
    }
    var requiredRole = resolveRequiredRole_(command);
    var evaluation = securityModule.enforceRole(requiredRole, {
      command: command,
      resource: 'command',
      payloadSummary: summarizePayload_(payload)
    });
    if (!evaluation || evaluation.allowed !== true) {
      throw new Error('Forbidden: ' + command + ' requires role ' + requiredRole);
    }
  }

  function resolveRequiredRole_(command) {
    switch (command) {
      case '@migrate':
      case '@sync':
      case '@commit':
      case '@debt':
      case '@invest':
      case '@reconcile':
        return 'owner';
      case '@import':
      case '@categorize':
      case '@analytics':
      case '@dashboard':
        return 'editor';
      case '@ui':
        return 'viewer';
      case '@security':
        return 'owner';
      default:
        return 'viewer';
    }
  }

  return {
    registerModules: registerModules,
    handleCommand: handleCommand,
    createTraceContext: createTraceContext
  };
})();
