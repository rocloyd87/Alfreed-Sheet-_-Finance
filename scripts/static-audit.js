#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function collectFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  entries.forEach((entry) => {
    if (entry.name.startsWith('.')) {
      return;
    }
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(absolute));
      return;
    }
    if (/\.(gs|js)$/.test(entry.name)) {
      results.push(path.relative(process.cwd(), absolute));
    }
  });
  return results;
}

const files = collectFiles(path.resolve('apps-script'));

const findings = [];

files.forEach((file) => {
  const absolute = path.resolve(file);
  const code = fs.readFileSync(absolute, 'utf8');
  try {
    new vm.Script(code, { filename: file });
  } catch (err) {
    findings.push({ file, level: 'error', message: `Syntax error: ${err.message}` });
  }

  if (code.includes('eval(') || code.includes('Function(')) {
    findings.push({ file, level: 'warn', message: 'Avoid dynamic evaluation (`eval`/`Function`).' });
  }

  if (!code.includes("'use strict'")) {
    findings.push({ file, level: 'warn', message: 'File missing strict mode directive.' });
  }

  if (code.includes('Logger.')) {
    findings.push({ file, level: 'warn', message: 'Avoid using Logger, prefer Logs.logEvent.' });
  }

  const todos = code.match(/TODO/gi);
  if (todos) {
    findings.push({ file, level: 'warn', message: `Contains ${todos.length} TODO markers.` });
  }
});

if (!findings.length) {
  console.log('Static audit completed with no findings.');
  process.exit(0);
}

let hasErrors = false;
findings.forEach((finding) => {
  console.log(`[${finding.level.toUpperCase()}] ${finding.file} - ${finding.message}`);
  if (finding.level === 'error') {
    hasErrors = true;
  }
});

process.exit(hasErrors ? 1 : 0);
