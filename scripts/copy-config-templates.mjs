import { cp, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const sourceDir = resolve(projectRoot, "src", "config", "config_template");
const targetDir = resolve(projectRoot, "dist", "config", "config_template");

await assertPathExists(sourceDir);
await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });

async function assertPathExists(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Template source directory not found: ${path}`);
  }
}
