// Checks of a translation against the Korean reference (DESIGN §27), used by tests/i18n.test.ts (server texts) and
// web/tests/i18n.test.ts (web texts). The types already refuse missing or extra keys; these also catch what a type
// cannot see: an empty namespace filled on one side only, empty texts, and Korean left in a translation.

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

type Kind = 'string' | 'function' | 'array' | 'object' | 'other';

function kindOf(value: unknown): Kind {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return 'other';
}

/** Where `other` differs in shape from `ref`: missing or extra keys, a text where the reference has a function, … */
export function shapeProblems(ref: unknown, other: unknown, at = ''): string[] {
  const a = kindOf(ref);
  const b = kindOf(other);
  if (a !== b) return [`${at || '(root)'}: ${b} where the reference has ${a}`];
  if (a === 'string') return ref !== '' && other === '' ? [`${at}: empty text`] : [];
  if (a === 'array') {
    const x = ref as unknown[];
    const y = other as unknown[];
    if (x.length !== y.length) return [`${at}: ${y.length} items where the reference has ${x.length}`];
    return x.flatMap((item, i) => shapeProblems(item, y[i], `${at}[${i}]`));
  }
  if (a !== 'object') return [];
  const x = ref as Record<string, unknown>;
  const y = other as Record<string, unknown>;
  const out: string[] = [];
  for (const key of Object.keys(x)) {
    const where = at ? `${at}.${key}` : key;
    if (!(key in y)) out.push(`${where}: missing`);
    else out.push(...shapeProblems(x[key], y[key], where));
  }
  for (const key of Object.keys(y)) if (!(key in x)) out.push(`${at ? `${at}.${key}` : key}: not in the reference`);
  return out;
}

/** Sample arguments a message function is called with (numbers for counts, words for names, a list for lists). */
const SAMPLES: unknown[] = [1, 2, 'x', ['a', 'b']];

/** Texts of `value` that contain Hangul: strings, results of message functions, and rich text (React elements). */
export function hangulIn(value: unknown, at = ''): string[] {
  if (typeof value === 'string') return HANGUL.test(value) ? [`${at}: ${JSON.stringify(value)}`] : [];
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    const found = new Set<string>();
    for (const sample of SAMPLES) {
      let result: unknown;
      try {
        result = fn(...Array.from({ length: Math.max(fn.length, 1) }, () => sample));
      } catch {
        continue; // not callable with this kind of argument
      }
      for (const problem of hangulIn(result, `${at}(${JSON.stringify(sample)})`)) found.add(problem);
    }
    return [...found];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => hangulIn(item, `${at}[${i}]`));
  if (value !== null && typeof value === 'object') {
    // A React element (rich text): its children.
    if ('props' in value && '$$typeof' in value) return hangulIn((value as { props: { children?: unknown } }).props.children, at);
    return Object.entries(value).flatMap(([key, item]) => hangulIn(item, at ? `${at}.${key}` : key));
  }
  return [];
}
