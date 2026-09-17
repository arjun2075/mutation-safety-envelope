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

describe("v0.2.0 negative cases retained in v0.3.0 (spec §1b, §4b)", () => {
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

  it("rejects incomplete or outcome-contradictory UnitResult fields", () => {
    const doc = {
      commitResult: {
        quoteId: "q1",
        unitResults: [{ unitRef: "unit_a", outcome: "APPLIED" }],
      },
    };
    expect(validate(doc)).toBe(false);

    const contradictory = [
      {
        unitRef: "unit_a",
        outcome: "APPLIED",
        committedEffects: [],
        refusalReason: "PROVIDER_REJECTED",
      },
      {
        unitRef: "unit_a",
        outcome: "APPLIED",
        committedEffects: [],
        reconciliation: { mode: "NONE" },
      },
      {
        unitRef: "unit_a",
        outcome: "REFUSED",
        refusalReason: "PROVIDER_REJECTED",
        reconciliation: { mode: "NONE" },
      },
      {
        unitRef: "unit_a",
        outcome: "INDETERMINATE",
        refusalReason: "PROVIDER_REJECTED",
        reconciliation: { mode: "NONE" },
      },
    ];
    for (const unitResult of contradictory) {
      expect(validate({ commitResult: { quoteId: "q1", unitResults: [unitResult] } })).toBe(false);
    }
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

describe("v0.3.0 admission-message negative cases", () => {
  const baseRefusal = {
    kind: "ADMISSION_REFUSED",
    admissionRefusal: {
      quoteId: "q1",
      proposalId: "p1",
      evaluatedAt: "2026-09-05T16:00:00Z",
      coverage: [{ relationId: "retail:requires_companion", status: "FAILED" }],
      failures: [
        {
          relationId: "retail:requires_companion",
          witness: {
            disposition: "COMPLETE",
            requiredTransitions: [
              {
                unitLocator: { scopeRef: "retail:order_1", unitKey: "unit_b" },
                transition: { operation: "CANCEL" },
              },
            ],
          },
        },
      ],
    },
  };

  it("accepts a well-formed ADMISSION_REFUSED CommitResponse", () => {
    expect(validate({ commitResponse: baseRefusal })).toBe(true);
  });

  it("rejects an admission failure with no witness", () => {
    const doc = structuredClone(baseRefusal);
    delete (doc.admissionRefusal.failures[0] as { witness?: unknown }).witness;
    expect(validate({ commitResponse: doc })).toBe(false);
  });

  it.each(["COMPLETE", "PARTIAL"])(
    "rejects %s repair with an empty requiredTransitions list",
    (disposition) => {
      const doc = structuredClone(baseRefusal);
      doc.admissionRefusal.failures[0].witness = {
        disposition,
        requiredTransitions: [],
      };
      expect(validate({ commitResponse: doc })).toBe(false);
    }
  );

  it("rejects UNAVAILABLE repair that carries a transition list", () => {
    const doc = structuredClone(baseRefusal);
    doc.admissionRefusal.failures[0].witness = {
      disposition: "UNAVAILABLE",
      requiredTransitions: baseRefusal.admissionRefusal.failures[0].witness.requiredTransitions,
    };
    expect(validate({ commitResponse: doc })).toBe(false);
  });

  it("rejects a refusal with no failed relations", () => {
    const doc = structuredClone(baseRefusal);
    doc.admissionRefusal.failures = [];
    expect(validate({ commitResponse: doc })).toBe(false);
  });

  it("rejects a CommitResponse carrying both result variants", () => {
    const doc = {
      ...baseRefusal,
      commitResult: {
        quoteId: "q1",
        unitResults: [{ unitRef: "u1", outcome: "REFUSED", refusalReason: "PROVIDER_REJECTED" }],
      },
    };
    expect(validate({ commitResponse: doc })).toBe(false);
  });

  it("rejects a v0.3.0 quote unit missing unitLocator or transition", () => {
    const doc = {
      quote: {
        quoteId: "q1",
        target: {},
        units: [{ unitRef: "u1", effects: [] }],
        admissionRelations: [],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a v0.3.0 quote that omits admissionRelations", () => {
    const doc = {
      quote: {
        quoteId: "q1",
        target: {},
        units: [
          {
            unitRef: "u1",
            unitLocator: { scopeRef: "scope", unitKey: "unit" },
            transition: {},
            effects: [],
          },
        ],
      },
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a relation with duplicate triggerUnitRefs at schema level", () => {
    const doc = {
      quote: {
        quoteId: "q1",
        target: {},
        units: [
          {
            unitRef: "u1",
            unitLocator: { scopeRef: "scope", unitKey: "unit" },
            transition: {},
            effects: [],
          },
        ],
        admissionRelations: [
          {
            relationId: "relation",
            type: "REQUIRES_COINCLUSION",
            triggerUnitRefs: ["u1", "u1"],
            scopeRef: "scope",
          },
        ],
      },
    };
    expect(validate(doc)).toBe(false);
  });
});

describe("v0.4.0-dev.0 admission report and satisfaction evidence", () => {
  const success = {
    kind: "COMMIT_RESULT",
    admissionReport: {
      quoteId: "q-pass",
      proposalId: "p-pass",
      evaluatedAt: "2026-09-16T20:00:00Z",
      failures: [],
      coverage: [{
        relationId: "retail:gate",
        status: "PASSED",
        satisfactions: [{
          source: "PRIOR_FINAL_TRANSITION",
          unitLocator: { scopeRef: "retail:order", unitKey: "delivery" },
          transition: { operation: "REDEEM" },
          transitionRef: "transition-42",
          finalizedAt: "2026-09-16T19:00:00Z",
        }],
      }],
    },
    commitResult: {
      quoteId: "q-pass",
      unitResults: [{ unitRef: "goods", outcome: "APPLIED", committedEffects: [] }],
    },
  };

  it("accepts a successful response with reader-facing prior-final satisfaction", () => {
    expect(validate({ commitResponse: success })).toBe(true);
  });

  it("rejects a successful response that omits its admission report", () => {
    const doc = structuredClone(success) as Partial<typeof success>;
    delete doc.admissionReport;
    expect(validate({ commitResponse: doc })).toBe(false);
  });

  it.each(["transitionRef", "finalizedAt"] as const)(
    "rejects prior-final evidence missing %s",
    (field) => {
      const doc = structuredClone(success);
      delete doc.admissionReport.coverage[0].satisfactions[0][field];
      expect(validate({ commitResponse: doc })).toBe(false);
    }
  );

  it("rejects malformed finalization time and incompatible source fields", () => {
    const malformed = structuredClone(success);
    malformed.admissionReport.coverage[0].satisfactions[0].finalizedAt = "yesterday";
    expect(validate({ commitResponse: malformed })).toBe(false);

    const incompatible = structuredClone(success);
    Object.assign(incompatible.admissionReport.coverage[0].satisfactions[0], { unitRef: "delivery" });
    expect(validate({ commitResponse: incompatible })).toBe(false);
  });
});

describe("required participant sets on PASSED coverage (UCP #799 completeness)", () => {
  const passedEntry = (overrides: Record<string, unknown> = {}) => ({
    commitResponse: {
      kind: "COMMIT_RESULT",
      admissionReport: {
        quoteId: "q-participants",
        proposalId: "p-participants",
        evaluatedAt: "2026-09-17T20:00:00Z",
        failures: [],
        coverage: [{
          relationId: "retail:gate",
          status: "PASSED",
          satisfactions: [{
            source: "CURRENT_REQUEST",
            unitRef: "u-delivery",
            transition: { operation: "REDEEM" },
          }],
          requiredParticipants: [{
            unitLocator: { scopeRef: "retail:order", unitKey: "delivery" },
            transition: { operation: "REDEEM" },
          }],
          ...overrides,
        }],
      },
      commitResult: {
        quoteId: "q-participants",
        unitResults: [{ unitRef: "u-delivery", outcome: "APPLIED", committedEffects: [] }],
      },
    },
  });

  it("accepts a PASSED entry carrying its required participant set", () => {
    expect(validate(passedEntry())).toBe(true);
  });

  it("accepts a two-participant required set", () => {
    expect(validate(passedEntry({
      requiredParticipants: [
        { unitLocator: { scopeRef: "retail:order", unitKey: "goods_1" }, transition: { operation: "CANCEL" } },
        { unitLocator: { scopeRef: "retail:order", unitKey: "goods_2" }, transition: { operation: "CANCEL" } },
      ],
    }))).toBe(true);
  });

  it("rejects an empty required participant set", () => {
    expect(validate(passedEntry({ requiredParticipants: [] }))).toBe(false);
  });

  it("rejects a duplicated required participant", () => {
    const participant = {
      unitLocator: { scopeRef: "retail:order", unitKey: "delivery" },
      transition: { operation: "REDEEM" },
    };
    expect(validate(passedEntry({
      requiredParticipants: [participant, structuredClone(participant)],
    }))).toBe(false);
  });

  it("rejects a required participant with no unitLocator or no transition", () => {
    expect(validate(passedEntry({
      requiredParticipants: [{ transition: { operation: "REDEEM" } }],
    }))).toBe(false);
    expect(validate(passedEntry({
      requiredParticipants: [{ unitLocator: { scopeRef: "retail:order", unitKey: "delivery" } }],
    }))).toBe(false);
  });

  it("rejects an unknown field on a required participant", () => {
    expect(validate(passedEntry({
      requiredParticipants: [{
        unitLocator: { scopeRef: "retail:order", unitKey: "delivery" },
        transition: { operation: "REDEEM" },
        finalizedAt: "2026-09-17T19:00:00Z",
      }],
    }))).toBe(false);
  });

  it("rejects requiredParticipants on a FAILED or DEFERRED entry", () => {
    const failed = passedEntry();
    failed.commitResponse.admissionReport.coverage[0] = {
      relationId: "retail:gate",
      status: "FAILED",
      requiredParticipants: [{
        unitLocator: { scopeRef: "retail:order", unitKey: "delivery" },
        transition: { operation: "REDEEM" },
      }],
    } as never;
    expect(validate(failed)).toBe(false);

    const deferred = passedEntry();
    deferred.commitResponse.admissionReport.coverage[0] = {
      relationId: "retail:gate",
      status: "DEFERRED",
      dependsOn: ["retail:other"],
      requiredParticipants: [{
        unitLocator: { scopeRef: "retail:order", unitKey: "delivery" },
        transition: { operation: "REDEEM" },
      }],
    } as never;
    expect(validate(deferred)).toBe(false);
  });
});
