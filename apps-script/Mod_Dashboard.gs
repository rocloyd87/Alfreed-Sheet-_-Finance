/**
 * Dashboard data orchestration helpers.
 */
var Mod_Dashboard = (function () {
  'use strict';

  function buildPayload(options) {
    options = options || {};
    var analytics = Mod_Analytics.exportForDashboard({
      periodDays: options.periodDays,
      debtStrategy: options.debtStrategy,
      debtExtraPayment: options.debtExtraPayment,
      asJson: false
    });

    return {
      generatedAt: analytics.generatedAt || new Date().toISOString(),
      analytics: analytics.analytics || {},
      portfolio: analytics.portfolio || {},
      debtForecast: analytics.debtForecast || {}
    };
  }

  function serve(options) {
    var payload = buildPayload(options);
    return JSON.stringify(payload);
  }

  return {
    buildPayload: buildPayload,
    serve: serve
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Mod_Dashboard;
}
