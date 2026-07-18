// Generic property-based schema harness for swamp extensions.
//
// For every model in extensions/models/, derive a fast-check arbitrary from
// each declared zod schema (globalArguments, method arguments, resource
// schemas) via @traversable/zod-test, then assert that everything the
// arbitrary generates round-trips through the schema's own safeParse. This
// catches unsatisfiable schemas, constructs the generator can't honor, and
// default/optional wiring mistakes — for free, with no per-model test code.
//
// This file is identical across extensions; drop it in tests/property/.
import * as fc from "npm:fast-check@4.6.0";
import "npm:@traversable/zod-types@0.0.30";
import "npm:@traversable/registry@0.0.49";
import { zxTest } from "npm:@traversable/zod-test@0.0.28";
import { assert } from "jsr:@std/assert@1";

// deno-lint-ignore no-explicit-any
type AnySchema = { safeParse: (v: unknown) => { success: boolean; error?: any } };

function isZodSchema(v: unknown): v is AnySchema {
  return typeof v === "object" && v !== null && "_zod" in v &&
    // deno-lint-ignore no-explicit-any
    typeof (v as any).safeParse === "function";
}

// deno-lint-ignore no-explicit-any
function collectSchemas(model: any): [label: string, schema: AnySchema][] {
  const found: [string, AnySchema][] = [];
  if (isZodSchema(model.globalArguments)) {
    found.push(["globalArguments", model.globalArguments]);
  }
  for (const [name, method] of Object.entries(model.methods ?? {})) {
    // deno-lint-ignore no-explicit-any
    const args = (method as any)?.arguments;
    if (isZodSchema(args)) found.push([`methods.${name}.arguments`, args]);
  }
  for (const [name, resource] of Object.entries(model.resources ?? {})) {
    // deno-lint-ignore no-explicit-any
    const schema = (resource as any)?.schema;
    if (isZodSchema(schema)) found.push([`resources.${name}.schema`, schema]);
  }
  return found;
}

const modelsDir = new URL("../../extensions/models/", import.meta.url);
const modelFiles: string[] = [];
for await (const entry of Deno.readDir(modelsDir)) {
  if (entry.isFile && entry.name.endsWith(".ts")) modelFiles.push(entry.name);
}
modelFiles.sort();

for (const file of modelFiles) {
  const mod = await import(new URL(file, modelsDir).href);
  const model = mod.model ?? mod.extension;
  if (!model) continue;

  for (const [label, schema] of collectSchemas(model)) {
    Deno.test(`${file} ${label}: generated data is schema-valid`, () => {
      // deno-lint-ignore no-explicit-any
      const arb = zxTest.fuzz(schema as any);
      let formatSkips = 0;
      fc.assert(
        fc.property(arb, (value) => {
          const result = schema.safeParse(value);
          if (!result.success) {
            // @traversable/zod-test doesn't honor string *format*
            // refinements (datetime/uuid/email/... → invalid_format),
            // custom .refine()/.superRefine() rules (→ custom), or
            // array/string size bounds (→ too_small/too_big): it generates
            // values the schema then rejects. Those are generator
            // limitations, not schema bugs — skip them, fail on
            // everything else.
            const generatorLimitations = new Set(
              ["invalid_format", "custom", "too_small", "too_big"],
            );
            // deno-lint-ignore no-explicit-any
            const issues: any[] = result.error?.issues ?? [];
            if (
              issues.length > 0 &&
              issues.every((i) => generatorLimitations.has(i.code))
            ) {
              formatSkips++;
              return;
            }
          }
          assert(
            result.success,
            `schema rejected its own generated data: ${
              JSON.stringify(value)?.slice(0, 200)
            }\n${result.error}`,
          );
        }),
        { numRuns: 50 },
      );
      if (formatSkips > 0) {
        console.warn(
          `  note: ${formatSkips}/50 samples skipped (format/refinement/` +
            `size constraints not supported by the generator)`,
        );
      }
    });
  }
}
