// Validates every #graphql document in app/ against the downloaded Admin API schema.
// Run "npm run graphql-codegen" first to fetch the schema for the configured API version.
import fs from "node:fs";
import path from "node:path";
import { buildClientSchema, parse, validate } from "graphql";

const schemaFile = fs.readdirSync("app/types").find((f) => /^admin-.*\.schema\.json$/.test(f));
const json = JSON.parse(fs.readFileSync(path.join("app/types", schemaFile), "utf8"));
const schema = buildClientSchema(json.data ?? json);

const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) && files.push(path.join(d, e.name))));
walk("app");

let failures = 0;
let count = 0;
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const fragments = [...src.matchAll(/`#graphql([\s\S]*?)`/g)].map((m) => m[1]).filter((d) => /^\s*fragment/.test(d));
  for (const m of src.matchAll(/`#graphql([\s\S]*?)`/g)) {
    let doc = m[1].replace(/\$\{PRODUCT_FIELDS\}/g, "");
    if (/^\s*fragment/.test(doc)) continue;
    if (doc.includes("...CartovumProduct")) doc += fragments.join("\n");
    count++;
    const errors = validate(schema, parse(doc));
    if (errors.length) {
      failures++;
      console.log(`${file}:\n  ${errors.map((e) => e.message).join("\n  ")}`);
    }
  }
}
console.log(`${count} documents checked against ${schemaFile}; ${failures} invalid.`);
process.exit(failures ? 1 : 0);
