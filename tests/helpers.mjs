// Shared by the tests: the site's shared browser scripts (js/*.js) as one string,
// so tests can pull single functions out by regex regardless of which file holds them.
import fs from "node:fs";

export function readSharedScripts() {
  const dir = new URL("../js/", import.meta.url);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => fs.readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
}
