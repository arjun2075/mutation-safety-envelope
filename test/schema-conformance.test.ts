import { describe, it, expect, beforeAll } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "schema", "mse-core.schema.json");
const examplesDir = path.join(__dirname, "..", "examples");

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function findFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFixtures(full));
    else if (entry.name.endsWith(".fixture.json")) out.push(full);
  }
  return out;
}

describe("schema self-consistency", () => {
  it("compiles as a valid JSON Schema (draft 2020-12)", () => {
    expect(validate).toBeTypeOf("function");
  });
});

describe("domain example fixtures conform to the core schema", () => {
  const fixtures = findFixtures(examplesDir);

  it("finds at least one fixture per domain example", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });

  for (const fixturePath of fixtures) {
    const relative = path.relative(examplesDir, fixturePath);
    it(`${relative} conforms to mse-core.schema.json`, () => {
      const doc = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
      const ok = validate(doc);
      if (!ok) {
        throw new Error(
          `${relative} failed schema validation:\n` + JSON.stringify(validate.errors, null, 2)
        );
      }
      expect(ok).toBe(true);
    });
  }
});
