const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let ModSecurity;
let sheets;
let accessLog;

function createSheet(name, rows) {
  const sheet = {
    name,
    data: rows.slice(),
    getDataRange() {
      const self = this;
      return {
        getValues() {
          return self.data;
        },
        setValues(values) {
          self.data = values;
        }
      };
    },
    getLastColumn() {
      return this.data[0] ? this.data[0].length : 0;
    },
    getLastRow() {
      return this.data.length;
    },
    getRange(row, col, numRows, numCols) {
      const self = this;
      return {
        setValues(values) {
          for (let r = 0; r < numRows; r++) {
            self.data[row - 1 + r] = self.data[row - 1 + r] || [];
            for (let c = 0; c < numCols; c++) {
              self.data[row - 1 + r][col - 1 + c] = values[r][c];
            }
          }
        },
        getValues() {
          const result = [];
          for (let r = 0; r < numRows; r++) {
            result[r] = [];
            for (let c = 0; c < numCols; c++) {
              result[r][c] = (self.data[row - 1 + r] || [])[col - 1 + c];
            }
          }
          return result;
        },
        setValue(value) {
          self.data[row - 1] = self.data[row - 1] || [];
          self.data[row - 1][col - 1] = value;
        }
      };
    },
    appendRow(row) {
      this.data.push(row);
      if (this.name === 'Security_Access_Log') {
        accessLog.push(row);
      }
    },
    deleteRow(index) {
      this.data.splice(index - 1, 1);
    },
    clearContents() {
      this.data = [[null, null]];
    }
  };
  sheets[name] = sheet;
  return sheet;
}

function ensureSheet(name, rows) {
  if (!sheets[name]) {
    createSheet(name, rows);
  }
  return sheets[name];
}

test.before(async () => {
  sheets = {};
  accessLog = [];
  global.Logs = { logEvent: () => {} };
  ensureSheet('Security_Roles', [
    ['email', 'role'],
    ['user@example.com', 'viewer'],
    ['*', 'editor']
  ]);
  ensureSheet('Security_Access_Log', []);

  global.SpreadsheetApp = {
    getActiveSpreadsheet() {
      return {
        getSheetByName(name) {
          return sheets[name] || null;
        },
        insertSheet(name) {
          return createSheet(name, []);
        }
      };
    }
  };
  global.Session = {
    getActiveUser() {
      return {
        getEmail() {
          return 'user@example.com';
        }
      };
    }
  };
  global.PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(key) {
          return key === 'ALFRED_SECRET_API' ? 'shh' : null;
        }
      };
    }
  };
  global.Mod_Config = {
    load() {
      return {
        securityRolesSheet: 'Security_Roles',
        securityAccessLogSheet: 'Security_Access_Log'
      };
    }
  };

  const code = fs.readFileSync(path.resolve('apps-script/Mod_Security.gs'), 'utf8');
  const context = {
    Logs: global.Logs,
    SpreadsheetApp: global.SpreadsheetApp,
    Session: global.Session,
    PropertiesService: global.PropertiesService,
    Mod_Config: global.Mod_Config,
    module: { exports: {} },
    exports: {}
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'Mod_Security.gs' });
  ModSecurity = context.module.exports || context.Mod_Security;
});

test.beforeEach(() => {
  accessLog.length = 0;
});

test('redactPII masks emails and long digits', () => {
  assert.equal(ModSecurity.redactPII('user@example.com'), 'u***@example.com');
  assert.equal(ModSecurity.redactPII('Account 123456789'), 'Account *********');
});

test('enforceRole allows when wildcard grants editor', () => {
  sheets['Security_Roles'].data = [
    ['email', 'role'],
    ['*', 'editor']
  ];
  const result = ModSecurity.enforceRole('editor', { command: '@analytics' });
  assert.equal(result.allowed, true);
  assert.equal(accessLog.length > 0, true);
});

test('enforceRole denies insufficient role', () => {
  sheets['Security_Roles'].data = [
    ['email', 'role'],
    ['user@example.com', 'viewer']
  ];
  const result = ModSecurity.enforceRole('owner', { command: '@sync' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'INSUFFICIENT_ROLE');
});

test('getSecret reads script property', () => {
  assert.equal(ModSecurity.getSecret('api'), 'shh');
});

test('seedDefaults creates wildcard viewer and owner', () => {
  sheets['Security_Roles'].data = [['email', 'role']];
  const result = ModSecurity.seedDefaults({ ownerEmail: 'founder@example.com' });
  assert.equal(result.seeded, true);
  const roles = ModSecurity.listRoles();
  assert.equal(roles.length, 2);
});

test('upsertRole adds and updates entries', () => {
  sheets['Security_Roles'].data = [['email', 'role']];
  ModSecurity.upsertRole('viewer@example.com', 'viewer');
  ModSecurity.upsertRole('viewer@example.com', 'editor');
  const roles = ModSecurity.listRoles();
  assert.equal(roles[0].role, 'editor');
});

test('removeRole deletes matching entry', () => {
  sheets['Security_Roles'].data = [
    ['email', 'role'],
    ['user@example.com', 'viewer']
  ];
  const removed = ModSecurity.removeRole('user@example.com');
  assert.equal(removed, true);
  assert.equal(ModSecurity.listRoles().length, 0);
});
