import { BackendError } from './bridge.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = () => { throw new BackendError('Tool arguments do not match the input schema'); };
const limit = () => { throw new BackendError('Tool schema validation exceeds complexity limit'); };

function reference(root, ref) {
  if (ref === '#') return root;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new BackendError('Only local tool schema references are supported', 400);
  let target = root;
  for (const part of ref.slice(2).split('/')) {
    let key;
    try { key = decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~'); }
    catch { throw new BackendError('Invalid tool schema reference', 400); }
    if (!object(target) || !Object.hasOwn(target, key)) throw new BackendError('Unresolved tool schema reference', 400);
    target = target[key];
  }
  if (target !== true && target !== false && !object(target)) throw new BackendError('Invalid tool schema reference target', 400);
  return target;
}

// Check references before sending any prompt. Unknown constraint keywords remain
// the caller's responsibility; this is deliberately a bounded schema subset.
export function checkSchema(root) {
  let remaining = 10_000;
  const visit = (schema, depth) => {
    if (--remaining < 0 || depth > 32) limit();
    if (typeof schema === 'boolean') return;
    if (!object(schema)) throw new BackendError('Invalid tool input schema', 400);
    if (Object.hasOwn(schema, '$ref')) reference(root, schema.$ref);
    for (const key of ['properties', '$defs', 'definitions']) {
      if (schema[key] === undefined) continue;
      if (!object(schema[key])) throw new BackendError('Invalid tool input schema', 400);
      for (const child of Object.values(schema[key])) visit(child, depth + 1);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      if (schema[key] === undefined) continue;
      if (!Array.isArray(schema[key]) || !schema[key].length) throw new BackendError('Invalid tool schema combination', 400);
      for (const child of schema[key]) visit(child, depth + 1);
    }
    for (const key of ['items', 'additionalProperties', 'not']) if (schema[key] !== undefined) visit(schema[key], depth + 1);
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) throw new BackendError('Invalid required tool properties', 400);
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new BackendError('Invalid tool input enum', 400);
  };
  visit(root, 0);
}

function canonical(value, budget, depth = 0) {
  if (--budget.remaining < 0 || depth > 32) limit();
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, budget, depth + 1)).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], budget, depth + 1)).join(',') + '}';
  return JSON.stringify(value);
}

export function validateInput(value, root) {
  const budget = { remaining: 100_000 };
  const equal = (a, b) => canonical(a, budget) === canonical(b, budget);
  const types = { object, array: Array.isArray, string: v => typeof v === 'string', number: v => typeof v === 'number' && Number.isFinite(v), integer: Number.isSafeInteger, boolean: v => typeof v === 'boolean', null: v => v === null };
  const matches = (v, schema, depth = 0) => {
    if (--budget.remaining < 0 || depth > 32) limit();
    if (typeof schema === 'boolean') return schema;
    if (!object(schema)) return true;
    if (schema.$ref !== undefined && !matches(v, reference(root, schema.$ref), depth + 1)) return false;
    const wanted = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (wanted.length && !wanted.some(t => types[t]?.(v))) return false;
    if (Object.hasOwn(schema, 'const') && !equal(v, schema.const)) return false;
    if (schema.enum && !schema.enum.some(item => equal(v, item))) return false;
    if (schema.allOf && !schema.allOf.every(s => matches(v, s, depth + 1))) return false;
    if (schema.anyOf && !schema.anyOf.some(s => matches(v, s, depth + 1))) return false;
    if (schema.oneOf && schema.oneOf.filter(s => matches(v, s, depth + 1)).length !== 1) return false;
    if (schema.not !== undefined && matches(v, schema.not, depth + 1)) return false;
    if (typeof v === 'number') {
      if (schema.minimum !== undefined && v < schema.minimum || schema.maximum !== undefined && v > schema.maximum ||
          schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && v >= schema.exclusiveMaximum) return false;
    }
    if (typeof v === 'string') {
      let length = 0;
      for (const char of v) length++;
      if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return false;
    }
    if (object(v)) {
      const entries = Object.entries(v);
      if (schema.minProperties !== undefined && entries.length < schema.minProperties || schema.maxProperties !== undefined && entries.length > schema.maxProperties) return false;
      for (const key of schema.required ?? []) if (!Object.hasOwn(v, key)) return false;
      for (const [key, item] of entries) {
        if (schema.properties && Object.hasOwn(schema.properties, key)) { if (!matches(item, schema.properties[key], depth + 1)) return false; }
        else if (schema.additionalProperties !== undefined && !matches(item, schema.additionalProperties, depth + 1)) return false;
      }
    }
    if (Array.isArray(v)) {
      if (schema.minItems !== undefined && v.length < schema.minItems || schema.maxItems !== undefined && v.length > schema.maxItems) return false;
      if (schema.uniqueItems && new Set(v.map(item => canonical(item, budget))).size !== v.length) return false;
      if (schema.items !== undefined && !v.every(item => matches(item, schema.items, depth + 1))) return false;
    }
    return true;
  };
  if (!matches(value, root)) reject();
}
