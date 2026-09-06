import { ModelNode, OddModel } from "./oddTypes";

/** Parsed TEI Publisher debug class, e.g. `tei-gap3` → gap + model #3. */
export interface TeiDebugSignature {
  ident: string;
  /** 1-based `<model>` index when present (wrappers are not counted). */
  modelIndex?: number;
}

export type TeiDebugJump =
  | { ok: true; ident: string; index: number; modelPath?: number[] }
  | { ok: false; reason: string };

/**
 * Parse a TEI Publisher HTML debug class against known elementSpec idents.
 * Uses the longest matching ident so `tei-div23` prefers `div2`+#3 over `div`+#23.
 */
export function parseTeiDebugClass(
  input: string,
  idents: readonly string[]
): TeiDebugSignature | undefined {
  const m = /^tei-(.+)$/i.exec(input.trim());
  if (!m) {
    return undefined;
  }
  const rest = m[1];
  const restLower = rest.toLowerCase();
  const sorted = [...idents]
    .filter((id) => !!id)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  for (const ident of sorted) {
    const identLower = ident.toLowerCase();
    if (restLower === identLower) {
      return { ident };
    }
    if (restLower.startsWith(identLower)) {
      const suffix = rest.slice(identLower.length);
      if (/^[1-9]\d*$/.test(suffix)) {
        return { ident, modelIndex: Number(suffix) };
      }
    }
  }
  return undefined;
}

/**
 * Path of the Nth `<model>` in document order, descending into modelGrp /
 * modelSequence without counting those wrappers (TEI Publisher numbering).
 */
export function findNthModelPath(
  models: ModelNode[],
  n: number
): number[] | undefined {
  if (n < 1) {
    return undefined;
  }
  let remaining = n;
  const walk = (
    list: ModelNode[],
    prefix: number[]
  ): number[] | undefined => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const path = [...prefix, i];
      if (node.type === "model") {
        remaining -= 1;
        if (remaining === 0) {
          return path;
        }
      } else {
        const hit = walk(node.models, path);
        if (hit) {
          return hit;
        }
      }
    }
    return undefined;
  };
  return walk(models, []);
}

/**
 * Resolve a QuickPick value to a jump target. Returns `undefined` when the
 * value is not a `tei-…` debug class (normal ident filtering should apply).
 */
export function resolveTeiDebugJump(
  input: string,
  model: OddModel
): TeiDebugJump | undefined {
  const trimmed = input.trim();
  if (!/^tei-/i.test(trimmed)) {
    return undefined;
  }

  const idents = model.elementSpecs.map((s) => s.ident);
  const parsed = parseTeiDebugClass(trimmed, idents);
  if (!parsed) {
    return { ok: false, reason: `Unrecognized debug class "${trimmed}".` };
  }

  const index = model.elementSpecs.findIndex((s) => s.ident === parsed.ident);
  if (index < 0) {
    return { ok: false, reason: `No elementSpec "${parsed.ident}".` };
  }

  if (parsed.modelIndex === undefined) {
    return { ok: true, ident: parsed.ident, index };
  }

  const modelPath = findNthModelPath(
    model.elementSpecs[index].models,
    parsed.modelIndex
  );
  if (!modelPath) {
    return {
      ok: false,
      reason: `No model #${parsed.modelIndex} on <${parsed.ident}>.`,
    };
  }
  return { ok: true, ident: parsed.ident, index, modelPath };
}
