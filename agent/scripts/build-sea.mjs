// Build the Windows x64 Agent as a single Node.js SEA executable.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(rootDirectory, "package.json"), "utf8"));
const nodeVersion = "26.4.0";
const buildDirectory = path.join(rootDirectory, "build");
const releaseInputDirectory = path.join(buildDirectory, "release-inputs", `v${packageJson.version}`);
const configDirectory = path.join(buildDirectory, "sea-config");
const output = path.join(releaseInputDirectory, "actl_windows_agent_x64.exe");

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { cwd: rootDirectory, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status}`);
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows x64 Agent 必须在 Windows x64 上构建");
}
if (process.versions.node < nodeVersion) {
  throw new Error(`SEA 构建 Node 必须大于等于目标运行时一致：需要 >= ${nodeVersion}，当前为 ${process.versions.node}`);
}
if (!existsSync(path.join(buildDirectory, "main.cjs"))) {
  throw new Error("缺少 build/main.cjs，请先执行 pnpm bundle");
}

mkdirSync(releaseInputDirectory, { recursive: true });
mkdirSync(configDirectory, { recursive: true });
const configPath = path.join(configDirectory, "win-x64.json");
const config = {
  main: path.join(buildDirectory, "main.cjs"),
  mainFormat: "commonjs",
  executable: process.execPath,
  output,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`构建 Windows x64 Agent -> ${path.relative(rootDirectory, output)}`);
rmSync(output, { force: true });
run(process.execPath, ["--build-sea", configPath]);

const hash = createHash("sha256").update(readFileSync(output)).digest("hex");
writeFileSync(path.join(releaseInputDirectory, "checksums.sha256"), `${hash}  ${path.basename(output)}\n`, "utf8");
console.log(`SEA 打包输入已写入 ${path.relative(rootDirectory, releaseInputDirectory)}`);
