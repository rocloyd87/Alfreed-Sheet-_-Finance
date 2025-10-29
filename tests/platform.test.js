const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let context;

function loadModule() {
  const code = fs.readFileSync(path.resolve('apps-script/Mod_Platform.gs'), 'utf8');
  const scriptCache = {
    store: new Map(),
    get(key) {
      return this.store.get(key) || null;
    },
    put(key, value) {
      this.store.set(key, value);
    },
    remove(key) {
      this.store.delete(key);
    },
    removeAll() {
      this.store.clear();
    }
  };
  context = {
    Logs: { logEvent: () => {} },
    CacheService: {
      getScriptCache() {
        return scriptCache;
      }
    },
    LockService: {
      getScriptLock() {
        return {
          tryLock() {
            return true;
          },
          releaseLock() {}
        };
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName() {
            return null;
          },
          insertSheet() {
            return {
              data: [],
              getRange() {
                return {
                  setValues(values) {
                    this.values = values;
                  }
                };
              },
              appendRow(row) {
                this.data.push(row);
              }
            };
          }
        };
      }
    },
    Utilities: { sleep() {} },
    module: { exports: {} },
    console
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'Mod_Platform.gs' });
}

test.before(loadModule);

test('cache get/set round trip', () => {
  context.Mod_Cache.set('demo', 'key', { value: 123 }, 30);
  const result = context.Mod_Cache.get('demo', 'key');
  assert.equal(result.value, 123);
  context.Mod_Cache.invalidate('demo', 'key');
  assert.equal(context.Mod_Cache.get('demo', 'key'), null);
});

test('locks.withLock executes function', () => {
  let executed = false;
  context.Mod_Locks.withLock('test', 100, () => {
    executed = true;
  });
  assert.equal(executed, true);
});

test('utils.chunkedProcess iterates', () => {
  let count = 0;
  const processed = context.Mod_Utils.chunkedProcess([1, 2, 3], 2, (slice) => {
    count += slice.length;
  });
  assert.equal(count, 3);
  assert.equal(processed, 3);
});
