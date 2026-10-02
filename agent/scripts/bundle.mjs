// 将应用源码打包为 Node.js SEA 使用的 CommonJS bundle。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(rootDirectory, "build", "main.cjs");

await build({
  absWorkingDir: rootDirectory,
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node26",
  format: "cjs",
  define: { __ACTL_AGENT_BUILD_FLAVOR__: '"release"' },
  outfile: bundlePath,
});
console.log("已生成 Agent SEA bundle");
