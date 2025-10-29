#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function loadPackageJson() {
  const pkgPath = path.resolve('package.json');
  const content = fs.readFileSync(pkgPath, 'utf8');
  return JSON.parse(content);
}

function run() {
  const pkg = loadPackageJson();
  const dependencies = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  const banned = ['lodash', 'underscore'];
  const findings = [];

  Object.keys(dependencies).forEach((dep) => {
    const version = dependencies[dep];
    if (banned.includes(dep)) {
      findings.push({ level: 'warn', message: `Dependency ${dep}@${version} is banned for security reasons.` });
    }
    if (/\*/.test(version)) {
      findings.push({ level: 'warn', message: `Dependency ${dep} uses wildcard version ${version}.` });
    }
  });

  if (!Object.keys(dependencies).length) {
    console.log('No runtime dependencies declared.');
  }

  if (!findings.length) {
    console.log('Security audit completed with no findings.');
    process.exit(0);
  }

  let hasErrors = false;
  findings.forEach((finding) => {
    console.log(`[${finding.level.toUpperCase()}] ${finding.message}`);
    if (finding.level === 'error') {
      hasErrors = true;
    }
  });

  process.exit(hasErrors ? 1 : 0);
}

run();
