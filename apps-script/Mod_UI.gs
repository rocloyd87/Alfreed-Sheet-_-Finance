/**
 * Command Center UI module (Phase 9).
 */
var Mod_UI = (function () {
  'use strict';

  function getAppPayload(options) {
    options = options || {};
    if (typeof Mod_Dashboard === 'undefined' || !Mod_Dashboard.buildPayload) {
      return {
        generatedAt: new Date().toISOString(),
        analytics: {},
        portfolio: {},
        debtForecast: {}
      };
    }

    return Mod_Dashboard.buildPayload({
      periodDays: options.periodDays || 30,
      debtStrategy: options.debtStrategy || 'snowball',
      debtExtraPayment: options.debtExtraPayment || 0
    });
  }

  function render(options) {
    var enforcement = ensureViewerAccess_();
    if (!enforcement.allowed) {
      return {
        status: 'DENIED',
        reason: enforcement.reason
      };
    }

    return {
      status: 'OK',
      payload: getAppPayload(options)
    };
  }

  function doGet(request) {
    var enforcement = ensureViewerAccess_();
    if (!enforcement.allowed) {
      return HtmlService.createHtmlOutput('<h1>Access denied</h1>');
    }

    var template = HtmlService.createTemplateFromFile('ui');
    template.app = {
      generatedAt: new Date().toISOString(),
      payload: getAppPayload(parseOptions_(request))
    };

    var output = template.evaluate();
    output.setTitle('Alfred 5.0 Command Center');
    output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    return output;
  }

  function parseOptions_(request) {
    var params = (request && request.parameter) || {};
    return {
      periodDays: params.periodDays ? Number(params.periodDays) : 30,
      debtStrategy: params.debtStrategy || 'snowball',
      debtExtraPayment: params.debtExtraPayment ? Number(params.debtExtraPayment) : 0
    };
  }

  function ensureViewerAccess_() {
    if (typeof Mod_Security === 'undefined' || !Mod_Security.enforceRole) {
      return { allowed: true, reason: 'SECURITY_MODULE_MISSING' };
    }

    return Mod_Security.enforceRole('viewer', { command: '@ui', resource: 'CommandCenter' });
  }

  return {
    render: render,
    doGet: doGet,
    getAppPayload: getAppPayload
  };
})();

function doGet(e) {
  return Mod_UI.doGet(e);
}
