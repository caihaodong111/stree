import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';

const addFormats = createRequire(import.meta.url)(
  'ajv-formats',
) as typeof import('ajv-formats').default;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

/** Remove transport wrappers only; never guess missing itinerary fields or brackets. */
export function unwrapModelJSON(text: string): string {
  return text
    .trim()
    .replace(/(?:\s*(?:<\/assistant>|<\|im_end\|>|<\|eot_id\|>))+\s*$/g, '')
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')
    .trim();
}

export function createOutputDecoder(schema: object) {
  const validate = ajv.compile(schema);
  // Per-task schemas should not accumulate in Ajv's strong-reference cache.
  ajv.removeSchema(schema);
  return (
    text: string,
  ): { text: string; error: string | null; value?: unknown; repairPaths?: string[] } => {
    const normalized = unwrapModelJSON(text);
    let value: unknown;
    try {
      value = JSON.parse(normalized);
    } catch {
      return { text: normalized, error: 'JSON 语法错误：检查引号、逗号和对象/数组的闭合括号。' };
    }
    if (!validate(value)) {
      const errors = validate.errors
        ?.slice(0, 6)
        .map(
          (issue) =>
            `${issue.instancePath || '/'} ${issue.message}${issue.keyword === 'required' ? ` (${issue.params.missingProperty})` : ''}`,
        );
      const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
      const repairPaths = [
        ...new Set(
          validate.errors?.map((issue) =>
            issue.keyword === 'required'
              ? `${issue.instancePath}/${escape(issue.params.missingProperty)}`
              : issue.keyword === 'additionalProperties'
                ? `${issue.instancePath}/${escape(issue.params.additionalProperty)}`
                : issue.instancePath,
          ),
        ),
      ];
      return {
        text: normalized,
        value,
        repairPaths,
        error: `展示字段不符合 schema：${errors?.join('；')}`,
      };
    }
    return { text: normalized, value, error: null };
  };
}

/** A provider may resume after a cut string as if its closing quote was sent.
 * Accept that single boundary quote only when the entire joined document parses.
 */
export function joinModelJSON(prefix: string, suffix: string): string {
  let inString = false;
  let escaped = false;
  for (const char of prefix) {
    if (escaped) escaped = false;
    else if (inString && char === '\\') escaped = true;
    else if (char === '"') inString = !inString;
  }
  if (inString && !escaped && /^\s*[,}\]]/.test(suffix)) {
    const joined = prefix + '"' + suffix;
    try {
      JSON.parse(unwrapModelJSON(joined));
      return joined;
    } catch {
      /* Other syntax errors need model recovery. */
    }
  }
  return prefix + suffix;
}

/** Apply only the schema validator's exact error paths; preserve every other field. */
export function applyOutputUpdates(
  value: unknown,
  updates: { path: string; value: unknown; remove: boolean }[],
  allowed: string[],
) {
  const result = structuredClone(value);
  for (const update of updates) {
    if (!allowed.includes(update.path) || !update.path.startsWith('/'))
      throw new Error('Invalid recovery path');
    const keys = update.path
      .slice(1)
      .split('/')
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (keys.some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)))
      throw new Error('Unsafe recovery path');
    let parent: any = result;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key))
        throw new Error('Missing recovery parent');
      parent = parent[key];
    }
    const key = keys.at(-1)!;
    if (!parent || typeof parent !== 'object' || Array.isArray(parent))
      throw new Error('Recovery must target an object field');
    if (update.remove) delete parent[key];
    else parent[key] = update.value;
  }
  return result;
}

/** Equivalent parameter objects share a query even when keys arrive in a different order. */
export function queryKey(name: string, args: unknown, originId?: string): string {
  const normalize = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      const text = value.trim().replace(/\s+/g, ' ');
      return name === 'measure_route' && ['fromId', 'toId'].includes(key) && text === originId
        ? 'origin'
        : text;
    }
    if (Array.isArray(value)) {
      const entries = value.map((item) => normalize(item));
      return key === 'queries' ? [...new Set(entries)].sort() : entries;
    }
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item, key)]),
      );
    return value;
  };
  return JSON.stringify([name, normalize(args)]);
}
