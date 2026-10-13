// Copies the Windows installers out of CARGO_TARGET_DIR into apps/desktop/installers.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const { version } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
);
const targetDir =
  process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, "../apps/desktop/src-tauri/target");

const outDir = resolve(import.meta.dirname, "../apps/desktop/installers");
try {
  rmSync(outDir, { recursive: true, force: true });
} catch (error) {
  // Windows can keep an installer open while it is being scanned or installed.
  if (error?.code !== "EPERM") throw error;
  console.warn(`Installer folder is in use; keeping existing files in ${outDir}.`);
}
mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const kind of ["nsis", "msi"]) {
  const dir = join(targetDir, "release", "bundle", kind);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!name.includes(`_${version}_`) || !/\.(exe|msi)$/i.test(name)) continue;
    copyFileSync(join(dir, name), join(outDir, name));
    console.log(`Installer: ${join(outDir, name)}`);
    copied++;
  }
}

if (!copied) {
  console.error(`No installers found under ${join(targetDir, "release", "bundle")}.`);
  process.exit(1);
}
