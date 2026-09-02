#!/usr/bin/env node
/**
 * Standalone strict-mode compile check for /schema/mse-core.schema.json.
 *
 * This exists because `ajv compile` (the ajv-cli package) is not a
 * dependency of this repository — using it here previously produced a
 * silently broken `npm run validate-schema` script (found during the
 * v0.1.0 hardening pass; see /docs/readiness-report.md). This script uses
 * the `ajv` library directly, the same way /test/schema-conformance.test.ts
 * does, so it exercises the identical strict-mode compile path.
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "schema", "mse-core.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

try {
  ajv.compile(schema);
  console.log(`OK: ${path.relative(process.cwd(), schemaPath)} compiles under ajv strict mode (draft 2020-12).`);
  process.exit(0);
} catch (err) {
  console.error(`FAIL: schema did not compile in strict mode.\n${err.message}`);
  process.exit(1);
}
