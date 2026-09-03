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

describe("v0.2.0 negative cases — the schema must reject these (spec §1b, §4b)", () => {
  it("(F) rejects an INDETERMINATE unitResult with no reconciliation at all", () => {
    const doc = {
      commitResult: {
        quoteId: "q1",
        unitResults: [{ unitRef: "unit_a", outcome: "INDETERMINATE" }],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("(F) rejects reconciliation with mode MACHINE_RESOLVABLE and no correlationId", () => {
    const doc = {
      commitResult: {
        quoteId: "q1",
        unitResults: [
          {
            unitRef: "unit_a",
            outcome: "INDETERMINATE",
            reconciliation: { mode: "MACHINE_RESOLVABLE" },
          },
        ],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("(F) rejects reconciliation with mode NONE that still carries a correlationId", () => {
    const doc = {
      commitResult: {
        quoteId: "q1",
        unitResults: [
          {
            unitRef: "unit_a",
            outcome: "INDETERMINATE",
            reconciliation: { mode: "NONE", correlationId: "should-not-be-here" },
          },
        ],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects an INDETERMINATE unitResult that also claims committedEffects", () => {
    const doc = {
      commitResult: {
        quoteId: "q1",
        unitResults: [
          {
            unitRef: "unit_a",
            outcome: "INDETERMINATE",
            reconciliation: { mode: "NONE" },
            committedEffects: [
              {
                effectId: "e1",
                type: "retail:order_total_delta",
                value: { type: "money", amount: "1.00", currency: "USD" },
                guarantee: { mode: "EXACT" },
              },
            ],
          },
        ],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a REFUSED unitResult with no refusalReason", () => {
    const doc = {
      commitResult: {
        quoteId: "q1",
        unitResults: [{ unitRef: "unit_a", outcome: "REFUSED" }],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a CommitResult with an empty unitResults array (minItems: 1)", () => {
    const doc = { commitResult: { quoteId: "q1", unitResults: [] } };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a MutationQuote with an empty units array (minItems: 1)", () => {
    const doc = { quote: { quoteId: "q1", target: {}, units: [] } };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a MutationQuote using the removed v0.1.0 top-level `effects` field", () => {
    const doc = {
      quote: {
        quoteId: "q1",
        target: {},
        effects: [
          {
            effectId: "e1",
            type: "retail:order_total_delta",
            value: { type: "money", amount: "1.00", currency: "USD" },
            guarantee: { mode: "EXACT" },
          },
        ],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a CommitResult using the removed v0.1.0 top-level `outcome` field", () => {
    const doc = { commitResult: { quoteId: "q1", outcome: "APPLIED" } };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a Receipt using the removed v0.1.0 top-level `mutationOutcome` field", () => {
    const doc = {
      receipt: { quoteId: "q1", mutationOutcome: "APPLIED", effectReceipts: [] },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects an AcceptanceConstraint using the removed v0.1.0 `effectType` field", () => {
    const doc = {
      commitRequest: {
        quoteId: "q1",
        acceptanceConstraints: [
          {
            effectType: "retail:order_total_delta",
            operator: "<=",
            value: { type: "money", amount: "1.00", currency: "USD" },
          },
        ],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("accepts a well-formed MIXED CommitResult (spec §1c) without an authoritative top-level outcome", () => {
    const doc = {
      commitResult: {
        quoteId: "q1",
        unitResults: [
          {
            unitRef: "unit_a",
            outcome: "APPLIED",
            committedEffects: [
              {
                effectId: "e1",
                type: "retail:order_total_delta",
                value: { type: "money", amount: "1.00", currency: "USD" },
                guarantee: { mode: "EXACT" },
              },
            ],
          },
          { unitRef: "unit_b", outcome: "REFUSED", refusalReason: "CONSTRAINT_VIOLATED" },
        ],
        aggregateHint: "MIXED",
      },
    };
    expect(validate(doc)).toBe(true);
  });
});
