import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentPackage = JSON.parse(await readFile(path.join(root, "agent", "package.json"), "utf8"));
const source = path.join(
  root,
  "agent",
  "build",
  "release-inputs",
  `v${agentPackage.version}`,
  "actl_windows_agent_x64.exe",
);
const targetDirectory = path.join(root, "src-tauri", "binaries");
const target = path.join(targetDirectory, "actl_windows_agent_x64.exe");

await mkdir(targetDirectory, { recursive: true });
await rm(target, { force: true });
await cp(source, target);
