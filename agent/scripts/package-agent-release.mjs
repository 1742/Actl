// Package the Windows x64 SEA executable as the Agent release archive.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
const releaseDirectory = path.join(rootDirectory, "releases", `v${packageJson.version}`);
const releaseInputDirectory = path.join(rootDirectory, "build", "release-inputs", `v${packageJson.version}`);
const agent = "actl_windows_agent_x64.exe";
const target = "win-x64";
const releaseNotes = process.env.ACTL_AGENT_RELEASE_NOTES?.trim() || `Actl Agent ${packageJson.version}`;

await access(path.join(releaseInputDirectory, agent));
await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

const manifest = `${JSON.stringify({ schemaVersion: 1, version: packageJson.version, target, agent }, null, 2)}\n`;
const checksums = [
  `${await sha256File(path.join(releaseInputDirectory, agent))}  ${agent}`,
  `${sha256Buffer(Buffer.from(manifest))}  release.json`,
];
const zip = new JSZip();
const archiveDate = new Date("2000-01-01T00:00:00.000Z");
zip.file(agent, createReadStream(path.join(releaseInputDirectory, agent)), {
  binary: true,
  compression: "STORE",
  date: archiveDate,
});
zip.file("release.json", manifest, { compression: "DEFLATE", date: archiveDate });
zip.file("checksums.sha256", `${checksums.join("\n")}\n`, { compression: "DEFLATE", date: archiveDate });

const targetDirectory = path.join(releaseDirectory, target);
await mkdir(targetDirectory, { recursive: true });
const output = path.join(targetDirectory, `actl-agent-${target}-${packageJson.version}.zip`);
const temporary = `${output}.tmp`;
await rm(temporary, { force: true });
await pipeline(zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE" }), createWriteStream(temporary, { flags: "wx" }));
await rename(temporary, output);

const sizeBytes = (await stat(output)).size;
const sha256 = await sha256File(output);
const release = { target, version: packageJson.version, packagePath: `${target}/${path.basename(output)}`, sha256, sizeBytes, entrypoint: agent, releaseNotes };
await writeFile(path.join(releaseDirectory, "manifest.cj"), `${JSON.stringify({
  schemaVersion: 1,
  channel: "stable",
  generatedAt: new Date().toISOString(),
  targets: { [target]: release },
}, null, 2)}\n`, "utf8");
console.log(`Created ${path.relative(rootDirectory, output)} (${sizeBytes} bytes, sha256 ${sha256})`);

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Buffer(content) {
  return createHash("sha256").update(content).digest("hex");
}
