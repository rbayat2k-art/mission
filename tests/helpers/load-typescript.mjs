import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// Execute the real module with explicit dependencies; no database or network.
export async function loadTypescript(url, dependencies = {}) {
  const source = await readFile(url, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  });
  const loadedModule = { exports: {} };
  const require = name => {
    if (!(name in dependencies)) throw new Error(`Unmocked dependency: ${name}`);
    return dependencies[name];
  };
  const execute = vm.runInThisContext(`(function(require,module,exports){${outputText}\n})`, { filename: url.pathname });
  execute(require, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
