import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, ".tmp", "test-build");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

const compile = spawnSync(
  process.execPath,
  [tsc, "--outDir", output, "--rootDir", root],
  { stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);

const tests = spawnSync(
  process.execPath,
  ["--test", path.join(output, "tests", "workflow.test.js")],
  { stdio: "inherit" },
);
process.exit(tests.status ?? 1);
