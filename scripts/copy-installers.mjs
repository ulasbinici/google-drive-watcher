// Copies the Windows installers out of CARGO_TARGET_DIR into apps/desktop/installers.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const targetDir =
  process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, "../apps/desktop/src-tauri/target");

const outDir = resolve(import.meta.dirname, "../apps/desktop/installers");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const kind of ["nsis", "msi"]) {
  const dir = join(targetDir, "release", "bundle", kind);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!/\.(exe|msi)$/i.test(name)) continue;
    copyFileSync(join(dir, name), join(outDir, name));
    console.log(`Installer: ${join(outDir, name)}`);
    copied++;
  }
}

if (!copied) {
  console.error(`No installers found under ${join(targetDir, "release", "bundle")}.`);
  process.exit(1);
}
