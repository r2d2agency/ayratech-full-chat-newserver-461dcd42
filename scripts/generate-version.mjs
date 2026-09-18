import { execFileSync } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const commit = process.env.BUILD_COMMIT || git(["rev-parse", "HEAD"]);
const commitShort = process.env.BUILD_COMMIT_SHORT || git(["rev-parse", "--short", "HEAD"]);
const buildTime = process.env.BUILD_TIME || new Date().toISOString();
const buildId = process.env.BUILD_ID || `${packageJson.version}-${commitShort}`;
const dirty = process.env.BUILD_DIRTY === "true" || (!process.env.BUILD_DIRTY && git(["status", "--porcelain"]) !== "");

const version = {
  version: packageJson.version,
  commit,
  commitShort,
  buildId,
  buildTime,
  dirty,
  web: buildId,
  promoter: buildId,
  timestamp: Date.parse(buildTime),
};

const target = join(root, "public", "version.json");
const temporary = `${target}.tmp`;
await writeFile(temporary, `${JSON.stringify(version, null, 2)}\n`, "utf8");
await rename(temporary, target);
console.log(`Generated version ${version.buildId} (${version.commitShort})`);
