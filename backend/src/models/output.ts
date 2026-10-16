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
  return (text: string): { text: string; error: string | null } => {
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
      return { text: normalized, error: `展示字段不符合 schema：${errors?.join('；')}` };
    }
    return { text: normalized, error: null };
  };
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
