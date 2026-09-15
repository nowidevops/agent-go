// Author: iDevOpsLLC
// Static import/export consistency check for the whole extension. ESM validates the entire
// import graph when the service worker loads, so ONE missing named export (e.g. a rewritten
// settings.js dropping isBannedPhaseTarget) fails service-worker registration with an opaque
// SyntaxError. This test catches that class of bug in Node, before loading in Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = fileURLToPath(new URL('../', import.meta.url));

function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (ent.name === 'test' || ent.name === 'icons' || ent.name === 'node_modules') continue; out.push(...listJs(path.join(dir, ent.name))); }
    else if (ent.name.endsWith('.js')) out.push(path.join(dir, ent.name));
  }
  return out;
}

// Collect the set of names a module exports (function/const/let/class/default + export{} lists).
function exportsOf(file) {
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const names = new Set();
  const re1 = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re1.exec(src))) names.add(m[1]);
  // export { a, b as c }  and  export { a } from './x'
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(src))) {
    for (const part of m[1].split(',')) {
      const seg = part.trim(); if (!seg) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      names.add(asMatch ? asMatch[1] : seg.split(/\s+/)[0]);
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  return names;
}

// Parse this file's static named imports from LOCAL (./) modules.
function localImports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const results = [];
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\})?\s*(?:\*\s*as\s*([A-Za-z_$][\w$]*))?\s*from\s*['"](\.\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const [, def, named, ns, spec] = m;
    const names = [];
    if (def) names.push('default');
    if (ns) names.push('*');
    if (named) for (const part of named.split(',')) {
      const seg = part.trim(); if (!seg) continue;
      names.push(seg.split(/\s+as\s+/)[0].trim()); // imported (source) name
    }
    results.push({ spec, names });
  }
  return results;
}

const exportCache = new Map();
function getExports(file) {
  if (!exportCache.has(file)) exportCache.set(file, exportsOf(file));
  return exportCache.get(file);
}

test('every local named import resolves to an actual export (service-worker load safety)', () => {
  const files = listJs(extDir);
  assert.ok(files.length > 30, `positive control: expected many .js files, got ${files.length}`);
  const problems = [];
  for (const f of files) {
    for (const imp of localImports(f)) {
      const target = path.resolve(path.dirname(f), imp.spec);
      if (!fs.existsSync(target)) { problems.push(`${path.basename(f)} -> missing module ${imp.spec}`); continue; }
      const exp = getExports(target);
      if (!exp) continue;
      for (const name of imp.names) {
        if (name === '*') continue;            // namespace import — always fine if module exists
        if (!exp.has(name)) problems.push(`${path.basename(f)} imports { ${name} } from ${imp.spec} — NOT exported`);
      }
    }
  }
  assert.deepEqual(problems, [], `Import/export mismatches (would break the service worker):\n  ${problems.join('\n  ')}`);
});
