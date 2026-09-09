import { isSafeNumber, LosslessNumber, parse } from 'lossless-json';
import { Document, Lexer, Parser, isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { STRUCTURED_DATA_LIMITS, type LocalToolHandler } from '@domos/contracts';
import { ensureUnicode } from './bytes.js';
import { InputFault, invalid, isRecord, limit, unsupported } from './errors.js';

function prepareJson(text: string): { text: string; prototypeKey: string | undefined } {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let separators = 0;
  let stringStart = 0;
  const scopes: (Set<string> | null)[] = [];
  const allKeys = new Set<string>();
  const prototypeKeys: { start: number; end: number }[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        quoted = false;
        let next = index + 1;
        while (/\s/.test(text[next] ?? '') && next < text.length) next++;
        const keys = scopes.at(-1);
        if (text[next] === ':' && keys) {
          const key: unknown = JSON.parse(text.slice(stringStart, index + 1));
          if (typeof key !== 'string') throw new Error('JSON key scanner did not read a string.');
          // lossless-json 4.x permits equal duplicate values; this lexical
          // guard rejects all duplicates before the library parses the data.
          if (keys.has(key)) invalid(`Duplicate JSON key at position ${stringStart}.`);
          keys.add(key);
          allKeys.add(key);
          if (key === '__proto__') prototypeKeys.push({ start: stringStart, end: index + 1 });
        }
      }
    } else if (char === '"') { quoted = true; stringStart = index; }
    else if (char === '{' || char === '[') {
      if (++depth > STRUCTURED_DATA_LIMITS.depth) limit('Structured data exceeds the 64-level depth limit.');
      scopes.push(char === '{' ? new Set<string>() : null);
    } else if (char === '}' || char === ']') { depth--; scopes.pop(); }
    else if (char === ',' && ++separators >= STRUCTURED_DATA_LIMITS.nodes) {
      limit('Structured data exceeds the 50,000-node budget.');
    }
  }
  if (!prototypeKeys.length) return { text, prototypeKey: undefined };
  let sequence = 0;
  let prototypeKey: string;
  do { prototypeKey = `\0domos-prototype-${sequence++}`; } while (allKeys.has(prototypeKey));
  const replacement = JSON.stringify(prototypeKey);
  const parts: string[] = [];
  let cursor = 0;
  for (const position of prototypeKeys) {
    parts.push(text.slice(cursor, position.start), replacement);
    cursor = position.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), prototypeKey };
}

function restorePrototypeKeys(value: unknown, key: string): void {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current instanceof LosslessNumber) continue;
    if (Array.isArray(current)) pending.push(...current);
    else if (isRecord(current)) {
      if (Object.hasOwn(current, key)) {
        const child = current[key];
        delete current[key];
        Object.defineProperty(current, '__proto__', { value: child, enumerable: true, configurable: true, writable: true });
      }
      pending.push(...Object.values(current));
    }
  }
}

export function checkJsonTree(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > STRUCTURED_DATA_LIMITS.nodes) limit('Structured data exceeds the 50,000-node budget.');
    if (item.depth > STRUCTURED_DATA_LIMITS.depth) limit('Structured data exceeds the 64-level depth limit.');
    if (typeof item.value === 'string') ensureUnicode(item.value);
    else if (item.value instanceof LosslessNumber) continue;
    else if (Array.isArray(item.value)) {
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
    } else if (isRecord(item.value)) {
      for (const [key, child] of Object.entries(item.value)) {
        ensureUnicode(key);
        if (++count > STRUCTURED_DATA_LIMITS.nodes) limit('Structured data exceeds the 50,000-node budget.');
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}

export function parseJson(text: string): unknown {
  let value: unknown;
  try {
    const prepared = prepareJson(text);
    value = parse(prepared.text, null, {
      onDuplicateKey: ({ position }) => { throw new SyntaxError(`Duplicate JSON key at position ${position}.`); },
    });
    // The dependency assigns object keys, so its __proto__ setter would lose
    // data. Parse a collision-free key and restore an own data property.
    if (prepared.prototypeKey !== undefined) restorePrototypeKeys(value, prepared.prototypeKey);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new InputFault('INVALID_INPUT', 'Invalid JSON.', [{ path: [], message: error.message.slice(0, 1000) }]);
    }
    throw error;
  }
  checkJsonTree(value);
  return value;
}

export function stringifyJson(value: unknown, indent?: number): string {
  const strings = new Set<string>();
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') strings.add(current);
    else if (current instanceof LosslessNumber) continue;
    else if (Array.isArray(current)) pending.push(...current);
    else if (isRecord(current)) {
      for (const [key, child] of Object.entries(current)) { strings.add(key); pending.push(child); }
    }
  }
  // Native JSON handles escaping/layout; collision-free string tokens carry
  // raw numeric lexemes. Unlike lossless-json's stringify duck typing, an input
  // object named {"isLosslessNumber":true} remains an ordinary JSON object.
  const numbers = new Map<string, string>();
  let sequence = 0;
  const output = JSON.stringify(value, (_key, current: unknown) => {
    if (!(current instanceof LosslessNumber)) return current;
    let token: string;
    do { token = `\0domos-number-${sequence++}`; } while (strings.has(token));
    numbers.set(JSON.stringify(token), current.value);
    return token;
  }, indent);
  if (output === undefined) throw new Error('JSON serializer returned no value.');
  return output.replace(/"\\u0000domos-number-\d+"/g, (token) => numbers.get(token) ?? token);
}

function yamlPreflight(text: string): void {
  let flowDepth = 0;
  for (const token of new Lexer().lex(text)) {
    if (token === '[' || token === '{') {
      if (++flowDepth > STRUCTURED_DATA_LIMITS.depth) limit('YAML exceeds the 64-level depth limit.');
    } else if (token === ']' || token === '}') flowDepth--;
  }
  let nodes = 0;
  let aliases = 0;
  // CST parsing is iterative; bound composition before its recursive AST pass.
  for (const token of new Parser().parse(text)) {
    const pending: { value: unknown; depth: number }[] = [{ value: token, depth: 0 }];
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (Array.isArray(value)) {
        for (const child of value) pending.push({ value: child, depth });
      } else if (isRecord(value)) {
        const collection = ['block-map', 'block-seq', 'flow-collection'].includes(String(value.type));
        const nextDepth = depth + Number(collection);
        if (nextDepth > STRUCTURED_DATA_LIMITS.depth) limit('YAML exceeds the 64-level depth limit.');
        if (value.type === 'alias' && ++aliases > STRUCTURED_DATA_LIMITS.aliases) limit('YAML exceeds the 50-alias limit.');
        if ((collection || value.type === 'scalar' || value.type === 'double-quoted-scalar'
          || value.type === 'single-quoted-scalar' || value.type === 'block-scalar')
          && ++nodes > STRUCTURED_DATA_LIMITS.nodes) limit('YAML exceeds the 50,000-node budget.');
        for (const child of Object.values(value)) {
          if (typeof child === 'object' && child !== null) pending.push({ value: child, depth: nextDepth });
        }
      }
    }
  }
}

const allowedTags = new Set(['str', 'null', 'bool', 'int', 'float', 'seq', 'map']
  .map((tag) => `tag:yaml.org,2002:${tag}`));

function yamlValue(document: Document): unknown {
  let nodes = 0;
  let aliases = 0;
  const active = new Set<unknown>();
  function convert(node: unknown, depth: number): unknown {
    if (++nodes > STRUCTURED_DATA_LIMITS.nodes) limit('Expanded YAML exceeds the 50,000-node budget.');
    if (depth > STRUCTURED_DATA_LIMITS.depth) limit('Expanded YAML exceeds the 64-level depth limit.');
    if (node === null) return null;
    if (active.has(node)) invalid('Cyclic YAML aliases cannot be represented as JSON-compatible data.');
    active.add(node);
    try {
      if (isNode(node) && node.tag && !allowedTags.has(node.tag)) unsupported('Custom and non-JSON YAML tags are not supported.');
      if (isAlias(node)) {
        if (++aliases > STRUCTURED_DATA_LIMITS.aliases) limit('Expanded YAML exceeds the 50-alias limit.');
        const resolved = node.resolve(document);
        if (!resolved) invalid('Unresolved YAML alias.');
        return convert(resolved, depth);
      }
      if (isMap(node)) {
        const entries: [string, unknown][] = [];
        const keys = new Set<string>();
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
            unsupported('YAML mappings require string keys for lossless JSON-compatible conversion.');
          }
          const key = pair.key.value;
          ensureUnicode(key);
          if (key === '<<') unsupported('YAML merge keys are not supported.');
          if (keys.has(key)) invalid('Duplicate YAML mapping key.');
          keys.add(key);
          entries.push([key, convert(pair.value, depth + 1)]);
        }
        return Object.fromEntries(entries);
      }
      if (isSeq(node)) return node.items.map((item) => convert(item, depth + 1));
      if (isScalar(node)) {
        const value: unknown = node.value;
        if (typeof value === 'string') { ensureUnicode(value); return value; }
        if (typeof value === 'bigint') {
          if (value === 0n && /^-0+$/.test(node.source ?? '')) {
            node.value = -0;
            return new LosslessNumber('-0');
          }
          return new LosslessNumber(value.toString());
        }
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) unsupported('YAML Infinity and NaN cannot be represented in JSON.');
          const source = node.source;
          if (source !== undefined) {
            const normalized = source.replace(/^\+/, '').replace(/^(-?)\./, '$10.')
              .replace(/^(-?)0+(?=\d)/, '$1').replace(/\.(?=e|$)/i, '.0');
            if (!isSafeNumber(normalized)) unsupported('YAML decimal precision cannot be preserved by the formatter.');
            return new LosslessNumber(normalized);
          }
          return new LosslessNumber(String(value));
        }
        if (value === null || typeof value === 'boolean') return value;
      }
      unsupported('This YAML value is not representable as JSON-compatible data.');
    } finally {
      active.delete(node);
    }
  }
  return convert(document.contents, 0);
}

function jsonForYaml(value: unknown): unknown {
  if (value instanceof LosslessNumber) {
    if (/^-?\d+$/.test(value.value)) {
      return value.value === '-0' ? -0 : BigInt(value.value);
    }
    if (!isSafeNumber(value.value)) unsupported('This JSON decimal cannot be converted to YAML without losing precision.');
    return Number(value.value);
  }
  if (Array.isArray(value)) return value.map(jsonForYaml);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonForYaml(child)]));
  return value;
}

export const structured: LocalToolHandler<'json-yaml-workbench'> = async (input) => {
  let value: unknown;
  let document: Document | undefined;
  if (input.source === 'json') value = parseJson(input.text);
  else {
    yamlPreflight(input.text);
    document = parseDocument(input.text, {
      version: '1.2', schema: 'core', intAsBigInt: true,
      // Duplicate string keys are checked in linear time by yamlValue. The
      // composer's pairwise comparator is quadratic for large flat mappings.
      uniqueKeys: false, merge: false, resolveKnownTags: false, prettyErrors: false,
    });
    if (document.errors.length) {
      throw new InputFault('INVALID_INPUT', 'Invalid YAML.', document.errors.slice(0, 100).map((error) => ({
        path: [], message: error.message.slice(0, 1000),
      })));
    }
    if (document.warnings.length) unsupported(`Unsupported YAML: ${document.warnings[0]!.message.slice(0, 1000)}`);
    if (document.directives?.yaml.version !== '1.2') unsupported('Only YAML 1.2 is supported.');
    value = yamlValue(document);
  }
  const format = input.action === 'convert' ? input.target! : input.source;
  if (input.action === 'validate') {
    return {
      kind: 'result', notices: [], data: {
        valid: true, format, text: null, changed: false,
        comments: input.source === 'yaml' ? 'preserved' : 'not-applicable',
      },
    };
  }
  let text: string;
  if (format === 'json') {
    text = stringifyJson(value, input.action === 'minify' ? undefined : input.indent);
  } else {
    const yamlDocument = document ?? new Document(jsonForYaml(value), { version: '1.2', schema: 'core' });
    text = yamlDocument.toString({ indent: input.indent, lineWidth: 0 });
  }
  return {
    kind: 'result', notices: [], data: {
      valid: true, format, text, changed: text !== input.text,
      comments: input.source === 'yaml' ? format === 'yaml' ? 'preserved' : 'removed' : 'not-applicable',
    },
  };
};
