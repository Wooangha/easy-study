// Text normalisation and lexical features for aligning lecture speech (whisper output) to slide material
// (DESIGN §22 "Alignment"; ported from the alignment spike's text.ts, which chose every rule here).
//
// Two channels per token:
//  raw  : character n-grams of normalised tokens (Hangul syllables and Latin letters as they are);
//  skel : a coarse "Korean-loanword consonant skeleton", so that "퍼스트 셋" ~ "FIRST set", "팔로우" ~ "FOLLOW",
//         "논터미널" ~ "nonterminal" (whisper writes English terms inside Korean speech in Hangul). No dictionary:
//         both sides are mapped to one consonant alphabet by rule. Worth about +16 points on real Korean speech.
// Pure functions: no I/O.

const GREEK: Record<string, string> = {
  'ε': ' epsilon ',
  'ϵ': ' epsilon ',
  'α': ' alpha ',
  'β': ' beta ',
  'γ': ' gamma ',
  'δ': ' delta ',
  '∅': ' empty ',
  'Ø': ' empty ',
  '∪': ' union ',
  '∩': ' intersection ',
  '→': ' ',
  '⇒': ' ',
  '∈': ' in ',
};

const LATEX: Array<[RegExp, string]> = [
  [/\\(var)?epsilon/g, ' epsilon '],
  [/\\alpha/g, ' alpha '],
  [/\\beta/g, ' beta '],
  [/\\gamma/g, ' gamma '],
  [/\\emptyset|\\varnothing/g, ' empty '],
  [/\\cup/g, ' union '],
  [/\\cap/g, ' intersection '],
  [/\\mathrm|\\text|\\mathit|\\mathbf|\\operatorname/g, ' '],
  [/\\[a-zA-Z]+/g, ' '],
];

const TOKEN_RE = /[a-z]+|[0-9]+|[가-힣]+/g;

export function normalise(text: string): string {
  let t = text.normalize('NFKC');
  for (const [re, rep] of LATEX) t = t.replace(re, rep);
  t = t.replace(/[εϵαβγδ∅Ø∪∩→⇒∈]/g, (c) => GREEK[c] ?? ' ');
  // camelCase / PascalCase (SheepNoise → Sheep Noise) and letter-digit boundaries (B1 → B 1)
  t = t
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  t = t.toLowerCase();
  // A Hangul ↔ Latin boundary is a token boundary ("FIRST셋" → "first 셋").
  t = t.replace(/([a-z0-9])([가-힣])/g, '$1 $2').replace(/([가-힣])([a-z0-9])/g, '$1 $2');
  return t;
}

export function tokens(text: string): string[] {
  return normalise(text).match(TOKEN_RE) ?? [];
}

// ---- consonant skeleton --------------------------------------------------------------------------
// classes: p (p b f v ㅂㅃㅍ), t (t d ㄷㄸㅌ), k (k g c q ㄱㄲㅋ), s (s z j ch sh th ㅅㅆㅈㅉㅊ),
// l (l r ㄹ), m, n, N (ng / final ㅇ). Vowels, h, w, y dropped. Runs collapsed.
const INITIAL = ['k', 'k', 'n', 't', 't', 'l', 'm', 'p', 'p', 's', 's', '', 's', 's', 's', 'k', 't', 'p', ''];
const FINAL = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'm', 'p', 'p', 't', 't', 'N', 't', 't', 'k', 't', 'p', ''];

function hangulSkeleton(token: string): string {
  let out = '';
  for (const ch of token) {
    const c = (ch.codePointAt(0) ?? 0) - 0xac00;
    if (c < 0 || c > 11171) continue;
    out += INITIAL[Math.floor(c / 588)] + FINAL[c % 28];
  }
  return out;
}

const VOWELS = 'aeiouy';
const LATIN_CLASS: Record<string, string> = {
  b: 'p',
  f: 'p',
  v: 'p',
  p: 'p',
  d: 't',
  t: 't',
  k: 'k',
  q: 'k',
  s: 's',
  z: 's',
  j: 's',
  S: 's',
  l: 'l',
  m: 'm',
  n: 'n',
  N: 'N',
};

function latinSkeleton(word: string): string {
  const s = word
    .toLowerCase()
    .replace(/tion|sion/g, 'sn')
    .replace(/ph/g, 'f')
    .replace(/th|sh|ch/g, 'S')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/ng/g, 'N');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1] ?? '';
    if (VOWELS.includes(c) || c === 'h' || c === 'w') continue;
    if (c === 'r') {
      if (i === 0 || (next !== '' && VOWELS.includes(next))) out += 'l';
      continue;
    }
    if (c === 'c') {
      out += next !== '' && 'eiy'.includes(next) ? 's' : 'k';
      continue;
    }
    if (c === 'g') {
      out += next !== '' && 'eiy'.includes(next) && i > 0 ? 's' : 'k';
      continue;
    }
    out += LATIN_CLASS[c] ?? '';
  }
  return out;
}

// Korean letter names of spelled acronyms (EOF → 이오에프 → "p", LP → 엘피 → "lp").
const LETTER_NAME: Record<string, string> = {
  a: '',
  b: 'p',
  c: 's',
  d: 't',
  e: '',
  f: 'p',
  g: 's',
  h: 's',
  i: '',
  j: 's',
  k: 'k',
  l: 'l',
  m: 'm',
  n: 'n',
  o: '',
  p: 'p',
  q: 'k',
  r: 'l',
  s: 's',
  t: 't',
  u: '',
  v: 'p',
  w: 'tpl',
  x: 'ks',
  y: '',
  z: 's',
};

export function collapse(s: string): string {
  return s.replace(/(.)\1+/g, '$1');
}

export function skeletons(token: string, rawCase?: string): string[] {
  if (/^[가-힣]+$/.test(token)) return [collapse(hangulSkeleton(token))];
  if (/^[a-z]+$/.test(token)) {
    const out = [collapse(latinSkeleton(token))];
    if (token.length <= 4 && (rawCase === undefined || rawCase === rawCase.toUpperCase())) {
      out.push(collapse([...token].map((c) => LETTER_NAME[c] ?? '').join('')));
    }
    return out;
  }
  return [];
}

// ---- features ------------------------------------------------------------------------------------

export type Feat = Map<string, number>;

function addGrams(f: Feat, s: string, sizes: number[], prefix: string): void {
  const padded = `^${s}$`;
  for (const n of sizes) {
    for (let i = 0; i + n <= padded.length; i++) {
      const gram = padded.slice(i, i + n);
      if (gram.endsWith('^$')) continue;
      const key = prefix + gram;
      f.set(key, (f.get(key) ?? 0) + 1);
    }
  }
}

export interface FeatureOptions {
  /** Slide side: skeletons of Latin tokens only (Hangul words of the slide need no transliteration). */
  skelLatinOnly?: boolean;
  /** Speech side: strip common Korean particles glued to (loan)words before the skeleton ("퍼스트셋은" → "퍼스트셋"). */
  stripJosa?: boolean;
}

const JOSA = /(이랑|에서|으로|하고|까지|부터|에는|에도|이고|이죠|이에요|예요|입니다|이|가|은|는|을|를|의|에|로|랑|과|와|도|만|죠|요)$/;

/** Hangul 2-3-grams (H:), Latin 3-5-grams (L:), digits whole (D:) and skeleton 3-4-grams (S:). */
export function features(text: string, options: FeatureOptions = {}): { raw: Feat; skel: Feat } {
  const raw: Feat = new Map();
  const skel: Feat = new Map();
  const cased = text.normalize('NFKC').match(/[A-Za-z]+|[0-9]+|[가-힣]+/g) ?? [];
  const caseOf = new Map<string, string>();
  for (const c of cased) caseOf.set(c.toLowerCase(), c);
  for (const t of normalise(text).match(TOKEN_RE) ?? []) {
    const hangul = /^[가-힣]/.test(t);
    if (hangul) addGrams(raw, t, [2, 3], 'H:');
    else if (/^[a-z]/.test(t)) {
      if (t.length >= 2) addGrams(raw, t, [3, 4, 5], 'L:');
    } else raw.set(`D:${t}`, (raw.get(`D:${t}`) ?? 0) + 1);
    if (options.skelLatinOnly && hangul) continue;
    const base = hangul && options.stripJosa && t.length > 2 ? t.replace(JOSA, '') : t;
    for (const sk of skeletons(base, caseOf.get(t))) {
      if (sk.length < 2) continue;
      addGrams(skel, sk, [3, 4], 'S:');
    }
  }
  return { raw, skel };
}

/** Markdown decoration removed (slide material from digests). */
export function stripMarkdown(s: string): string {
  return s
    .replace(/```/g, ' ')
    .replace(/\*\*|__|`|#+ |\|/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
}
