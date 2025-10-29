const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let ModUI;

function loadModule(securityResult) {
  const code = fs.readFileSync(path.resolve('apps-script/Mod_UI.gs'), 'utf8');
  const context = {
    Logs: { logEvent: () => {} },
    HtmlService: {
      createTemplateFromFile() {
        return {
          data: null,
          evaluate() {
            return {
              setTitle() {},
              addMetaTag() {},
              getContent() {
                return '<html></html>';
              }
            };
          }
        };
      },
      createHtmlOutput(content) {
        return { getContent: () => content };
      }
    },
    Mod_Dashboard: {
      buildPayload() {
        return { generatedAt: 'now', analytics: { summary: 'ok' } };
      }
    },
    Mod_Security: {
      enforceRole() {
        return securityResult;
      }
    },
    module: { exports: {} },
    exports: {}
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'Mod_UI.gs' });
  ModUI = context.Mod_UI;
  return context;
}

test('render returns payload when allowed', () => {
  loadModule({ allowed: true });
  const result = ModUI.render({ periodDays: 45 });
  assert.equal(result.status, 'OK');
  assert.equal(result.payload.analytics.summary, 'ok');
});

test('render denies when security rejects', () => {
  loadModule({ allowed: false, reason: 'DENIED' });
  const result = ModUI.render({});
  assert.equal(result.status, 'DENIED');
  assert.equal(result.reason, 'DENIED');
});
