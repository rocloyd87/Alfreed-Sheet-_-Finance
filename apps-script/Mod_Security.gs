/**
 * Security and privacy helpers for Alfred 5.0.
 */
var Mod_Security = (function () {
  'use strict';

  var ROLE_ORDER = ['viewer', 'editor', 'owner'];

  function enforceRole(requiredRole, context) {
    requiredRole = (requiredRole || 'viewer').toLowerCase();
    var auditContext = context || {};
    var actor = resolveActor_();

    if (!actor || !actor.email) {
      // Running in a context without an active user (e.g. tests, triggers).
      return { allowed: true, reason: 'NO_ACTOR_CONTEXT' };
    }

    var roles = loadRoles_();
    var assignedRole = roles[actor.email] || roles['*'] || 'viewer';
    var allowed = compareRoles_(assignedRole, requiredRole) >= 0;

    logAccess_(actor.email, auditContext.command || 'UNKNOWN', auditContext.resource || 'GLOBAL', allowed);

    if (!allowed) {
      Logs.logEvent('WARN', 'Mod_Security', 'Role enforcement denied', {
        email: redactPII(actor.email),
        requiredRole: requiredRole,
        assignedRole: assignedRole
      });
      return {
        allowed: false,
        reason: 'INSUFFICIENT_ROLE',
        requiredRole: requiredRole,
        assignedRole: assignedRole
      };
    }

    return {
      allowed: true,
      assignedRole: assignedRole,
      requiredRole: requiredRole
    };
  }

  function redactPII(value) {
    if (value === null || typeof value === 'undefined') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(redactPII);
    }

    if (typeof value === 'object') {
      var clone = {};
      Object.keys(value).forEach(function (key) {
        clone[key] = redactPII(value[key]);
      });
      return clone;
    }

    if (typeof value !== 'string') {
      return value;
    }

    var sanitized = value.trim();
    if (!sanitized) {
      return sanitized;
    }

    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sanitized)) {
      return sanitized.replace(/(^.).*(@.*$)/, '$1***$2');
    }

    if (/\b\d{6,}\b/.test(sanitized)) {
      return sanitized.replace(/\d/g, '*');
    }

    if (sanitized.length > 64) {
      return sanitized.slice(0, 61) + '…';
    }

    return sanitized;
  }

  function getSecret(key) {
    if (!key) {
      return null;
    }

    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      return null;
    }

    var normalized = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    var propertyKey = 'ALFRED_SECRET_' + normalized;
    return PropertiesService.getScriptProperties().getProperty(propertyKey);
  }

  function healthProbe() {
    try {
      var sheet = getSecuritySheet_(true);
      if (!sheet) {
        return { ok: false, reason: 'Security_Roles sheet missing' };
      }

      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var required = ['email', 'role'];
      var missing = required.filter(function (header) {
        return headers.indexOf(header) === -1;
      });

      var accessSheet = getAccessSheet_(true);

      return {
        ok: missing.length === 0 && !!accessSheet,
        missingHeaders: missing,
        accessLogPresent: !!accessSheet
      };
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Security', 'Health probe failed', { error: err.message });
      return { ok: false, error: err.message };
    }
  }

  function listRoles() {
    var sheet = getSecuritySheet_(true);
    if (!sheet) {
      return [];
    }

    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return [];
    }

    var headers = values[0];
    var map = {};
    headers.forEach(function (header, index) {
      map[header] = index;
    });

    return values.slice(1).filter(function (row) {
      return row && row.length > 0 && row[map.email];
    }).map(function (row) {
      return {
        email: (row[map.email] || '').toString(),
        role: (row[map.role] || '').toString()
      };
    });
  }

  function upsertRole(email, role) {
    if (!email || !role) {
      throw new Error('email and role are required');
    }

    var normalizedEmail = email.toString().trim().toLowerCase();
    var normalizedRole = normalizeRole_(role);
    var sheet = getSecuritySheet_(true);
    if (!sheet) {
      throw new Error('Security_Roles sheet unavailable');
    }

    var dataRange = sheet.getDataRange();
    var values = dataRange.getValues();
    var headers = values[0];
    var map = {};
    headers.forEach(function (header, index) {
      map[header] = index;
    });

    var updated = false;
    for (var i = 1; i < values.length; i++) {
      var rowEmail = (values[i][map.email] || '').toString().trim().toLowerCase();
      if (rowEmail === normalizedEmail) {
        sheet.getRange(i + 1, map.role + 1).setValue(normalizedRole);
        updated = true;
        break;
      }
    }

    if (!updated) {
      sheet.appendRow([normalizedEmail, normalizedRole]);
    }

    return { email: normalizedEmail, role: normalizedRole };
  }

  function removeRole(email) {
    if (!email) {
      return false;
    }

    var normalizedEmail = email.toString().trim().toLowerCase();
    var sheet = getSecuritySheet_();
    if (!sheet) {
      return false;
    }

    var range = sheet.getDataRange();
    var values = range.getValues();
    var headers = values[0];
    var map = {};
    headers.forEach(function (header, index) {
      map[header] = index;
    });

    for (var i = 1; i < values.length; i++) {
      var rowEmail = (values[i][map.email] || '').toString().trim().toLowerCase();
      if (rowEmail === normalizedEmail) {
        sheet.deleteRow(i + 1);
        return true;
      }
    }

    return false;
  }

  function seedDefaults(options) {
    options = options || {};
    var sheet = getSecuritySheet_(true);
    if (!sheet) {
      throw new Error('Security_Roles sheet unavailable');
    }

    var values = sheet.getDataRange().getValues();
    if (values.length > 1 && !options.force) {
      return { seeded: false, reason: 'EXISTING_ROLES' };
    }

    sheet.clearContents();
    sheet.getRange(1, 1, 1, 2).setValues([[ 'email', 'role' ]]);
    sheet.appendRow(['*', 'viewer']);
    if (options.ownerEmail) {
      sheet.appendRow([options.ownerEmail.toLowerCase(), 'owner']);
    }

    var accessSheet = getAccessSheet_(true);
    if (accessSheet && accessSheet.getLastRow() === 0) {
      accessSheet.getRange(1, 1, 1, 4).setValues([[ 'timestamp', 'email', 'action', 'resource' ]]);
    }

    return { seeded: true };
  }

  function resolveActor_() {
    try {
      if (typeof Session !== 'undefined' && Session.getActiveUser) {
        var email = Session.getActiveUser().getEmail();
        if (email) {
          return { email: email.toLowerCase() };
        }
      }
    } catch (err) {
      Logs.logEvent('WARN', 'Mod_Security', 'Failed to resolve active user', { error: err.message });
    }
    return null;
  }

  function loadRoles_() {
    var roles = {};
    var sheet = getSecuritySheet_();
    if (!sheet) {
      return roles;
    }

    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return roles;
    }

    var headers = values[0];
    var map = {};
    headers.forEach(function (header, index) {
      map[header] = index;
    });

    values.slice(1).forEach(function (row) {
      if (!row || !row.length) {
        return;
      }
      var emailIndex = map.email;
      var roleIndex = map.role;
      if (emailIndex === undefined || roleIndex === undefined) {
        return;
      }
      var email = (row[emailIndex] || '').toString().trim().toLowerCase();
      var role = (row[roleIndex] || '').toString().trim().toLowerCase();
      if (!email || !role) {
        return;
      }
      roles[email] = normalizeRole_(role);
    });

    return roles;
  }

  function getSecuritySheet_(ensure) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return null;
    }
    var config = Mod_Config.load();
    var sheetName = config.securityRolesSheet || 'Security_Roles';
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet && ensure) {
      sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(sheetName);
      sheet.getRange(1, 1, 1, 2).setValues([[ 'email', 'role' ]]);
    }
    return sheet;
  }

  function getAccessSheet_(ensure) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return null;
    }

    var config = Mod_Config.load();
    var sheetName = config.securityAccessLogSheet || 'Security_Access_Log';
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet && ensure) {
      sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(sheetName);
      sheet.getRange(1, 1, 1, 5).setValues([[ 'timestamp', 'email', 'action', 'resource', 'status' ]]);
    }
    return sheet;
  }

  function logAccess_(email, action, resource, allowed) {
    var sheet = getAccessSheet_(true);
    if (!sheet) {
      return;
    }

    try {
      sheet.appendRow([
        new Date().toISOString(),
        email,
        action,
        resource,
        allowed ? 'ALLOWED' : 'DENIED'
      ]);
    } catch (err) {
      Logs.logEvent('WARN', 'Mod_Security', 'Failed to append access log', { error: err.message });
    }
  }

  function compareRoles_(assigned, required) {
    var assignedIndex = ROLE_ORDER.indexOf(normalizeRole_(assigned));
    var requiredIndex = ROLE_ORDER.indexOf(normalizeRole_(required));
    if (assignedIndex === -1) {
      assignedIndex = 0;
    }
    if (requiredIndex === -1) {
      requiredIndex = ROLE_ORDER.length - 1;
    }
    return assignedIndex - requiredIndex;
  }

  function normalizeRole_(role) {
    if (!role) {
      return 'viewer';
    }
    var normalized = role.toString().trim().toLowerCase();
    if (ROLE_ORDER.indexOf(normalized) === -1) {
      return 'viewer';
    }
    return normalized;
  }

  return {
    enforceRole: enforceRole,
    redactPII: redactPII,
    getSecret: getSecret,
    healthProbe: healthProbe,
    listRoles: listRoles,
    upsertRole: upsertRole,
    removeRole: removeRole,
    seedDefaults: seedDefaults
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Mod_Security;
}
