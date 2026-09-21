/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS loader isolates TypeScript modules for a plain Node.js test process, mirroring scripts/verify-*.cjs's own harness. */
// Loads a server-only TypeScript module (one that imports "server-only")
// for use from a plain Node.js process, exactly like the ts.transpileModule
// + custom require shim scripts/verify-*.cjs already use offline. The
// Playwright Test runner has no bundler-level alias for "server-only" (that
// resolution is normally provided by Next.js/vinext's own compiler via the
// "react-server" export condition, which a plain Node `import` does not
// set -- see mock-browser-provider.contract.spec.ts's header comment), so
// value-level access to lib/automation/**'s server-only files from a
// Playwright spec goes through this loader instead of a native `import`.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..', '..');
const loadedModules = new Map();

function load(relative) {
  const filename = path.join(root, relative);
  if (loadedModules.has(filename)) return loadedModules.get(filename).exports;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  loadedModules.set(filename, mod);
  mod.require = (name) =>
    name === 'server-only'
      ? {}
      : name.startsWith('@/')
        ? load(name.slice(2) + '.ts')
        : require(name);
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    filename,
  );
  return mod.exports;
}

module.exports = { load };
