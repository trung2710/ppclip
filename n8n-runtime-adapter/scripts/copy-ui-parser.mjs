import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const src = path.join(root, "src", "ui-parser.cjs");
const dest = path.join(root, "dist", "ui-parser.cjs");

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
