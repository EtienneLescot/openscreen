import fs from "fs";
const [, , jsonPath] = process.argv;
const d = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
process.stdout.write((d.segments || []).map((s) => s.text).join(""));
