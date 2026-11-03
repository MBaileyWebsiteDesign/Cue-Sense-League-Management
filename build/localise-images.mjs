// Downloads every image the site still loads from Wix (listed by build.mjs in
// build/wix-images.json) into media/, so the site can be served without Wix.
// Run: node build/build.mjs && node build/localise-images.mjs && node build/build.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
const list = JSON.parse(readFileSync(new URL("./wix-images.json", import.meta.url), "utf8"));
const dir = new URL("../media/", import.meta.url);
mkdirSync(dir, { recursive: true });
let ok = 0, failed = 0;
const todo = list.filter((x) => !existsSync(new URL(x.name, dir)));
for (let i = 0; i < todo.length; i += 8) {
  await Promise.all(todo.slice(i, i + 8).map(async ({ name, url }) => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(new URL(name, dir), Buffer.from(await r.arrayBuffer()));
      ok++;
    } catch (e) { failed++; console.error("failed", url, e.message); }
  }));
}
console.log(`downloaded ${ok}, failed ${failed}, already had ${list.length - todo.length}`);
if (failed) process.exit(1);
