// UI languages (DESIGN §27), shared by the server and the web client. Korean is the reference language: every text is
// written in Korean first, and a language added here needs a messages file per namespace on both sides.

/** A supported language: 'ko' (the reference) or 'en'. To add one, extend this union and LANGS. */
export type Lang = 'ko' | 'en';

/** The supported languages with their names in their own language (the language picker shows these, untranslated). */
export const LANGS: ReadonlyArray<{ id: Lang; native: string }> = [
  { id: 'ko', native: '한국어' },
  { id: 'en', native: 'English' },
];

/** Korean: the default outside a browser (tests, the server outside a request) and when nothing says otherwise. */
export const DEFAULT_LANG: Lang = 'ko';

/** The language when the user's languages are known but none is supported. */
export const FALLBACK_LANG: Lang = 'en';

/** The request header the web client sends with every API request: the language to answer in. */
export const LANG_HEADER = 'X-Easy-Study-Lang';

/**
 * The query parameter that carries the same where no header can be sent: plain links (notes.md, digest.md,
 * summary.md) and EventSource streams (`?lang=en`).
 */
export const LANG_PARAM = 'lang';

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && LANGS.some((l) => l.id === v);

/** The supported language of a BCP 47 tag ('ko-KR' → 'ko', 'en_US.UTF-8' → 'en'), or null. */
export function langOfTag(tag: string): Lang | null {
  const primary = tag.trim().toLowerCase().split(/[-_.;]/, 1)[0];
  return isLang(primary) ? primary : null;
}

/**
 * The language for a list of the user's language tags, most preferred first (navigator.languages, Accept-Language):
 * the first supported one; English when there are tags but none is supported; null when there is no real tag.
 */
export function pickLang(tags: readonly string[]): Lang | null {
  const real = tags.map((t) => t.trim()).filter((t) => t !== '' && t !== '*');
  for (const tag of real) {
    const lang = langOfTag(tag);
    if (lang) return lang;
  }
  return real.length > 0 ? FALLBACK_LANG : null;
}

/** The tags of an Accept-Language header, by quality (highest first, ties in order); q=0 dropped. */
export function acceptLanguageTags(header: string | undefined | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((e) => e.tag !== '' && Number.isFinite(e.q) && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((e) => e.tag);
}
