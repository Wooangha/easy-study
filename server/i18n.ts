// The language of the server's user-facing texts (DESIGN §27): error messages and statuses sent to the web client,
// the files it writes for the user (DIGEST.md, STUDY_NOTES.md, COURSE.md) and the LLM's answer language.
//
// - Texts live in typed objects, one file per namespace and language: server/messages/ko/<ns>.ts is the reference,
//   server/messages/en/<ns>.ts must `satisfies typeof ko`. Dynamic texts are functions ((n: number) => string).
// - Each API request runs in its language (langContext(), first in the API router): the X-Easy-Study-Lang header the
//   web client sends, else its ?lang= parameter (plain links and EventSource, which send no header), else
//   Accept-Language, else Korean. `smsg()` is that language's texts; async work started by the
//   request (a digest, a transcription, an SSE turn) keeps it, since AsyncLocalStorage follows the continuations.
// - Outside a request (startup, resumed jobs) the language is Korean: work that outlives its request and is resumed
//   later stores its language and runs in it again with `runInLang(lang, fn)`.
// - Log lines (console.*) stay as they are; they are for whoever runs the server, not for the page.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import { DEFAULT_LANG, LANG_HEADER, LANG_PARAM, acceptLanguageTags, isLang, langOfTag, pickLang, type Lang } from '../shared/i18n.ts';
import { en } from './messages/en/index.ts';
import { ko, type ServerMessages } from './messages/ko/index.ts';

export { DEFAULT_LANG, isLang };
export type { Lang, ServerMessages };

const MESSAGES: Record<Lang, ServerMessages> = { ko, en };

const current = new AsyncLocalStorage<Lang>();

/** A request as requestLang reads it: its headers, and its parsed query (Express's req.query) when there is one. */
export interface LangRequest {
  get(name: string): string | undefined;
  query?: unknown;
}

/**
 * The language a request asks for: X-Easy-Study-Lang, else ?lang=ko|en (a plain link or an EventSource, which send no
 * header), else Accept-Language (a supported one first), else Korean.
 */
export function requestLang(req: LangRequest): Lang {
  const asked = req.get(LANG_HEADER);
  const lang = asked ? langOfTag(asked) : null;
  return lang ?? queryLang(req.query) ?? pickLang(acceptLanguageTags(req.get('Accept-Language'))) ?? DEFAULT_LANG;
}

function queryLang(query: unknown): Lang | null {
  const value = query !== null && typeof query === 'object' ? (query as Record<string, unknown>)[LANG_PARAM] : undefined;
  return isLang(value) ? value : null;
}

/** Middleware: the rest of the request (and the work it starts) runs in the request's language. */
export function langContext(): RequestHandler {
  return (req, _res, next) => current.run(requestLang(req), next);
}

/** The language of the current request (or of runInLang); Korean outside both. */
export function slang(): Lang {
  return current.getStore() ?? DEFAULT_LANG;
}

/** The server's texts in `lang` (default: the current request's language). */
export function smsg(lang: Lang = slang()): ServerMessages {
  return MESSAGES[lang];
}

/**
 * The language a process of the desktop app runs in (the local server, the relay): the shell's, passed as
 * EASY_STUDY_LANG; Korean when unset, English for a language the app does not have.
 */
export function envLang(env: NodeJS.ProcessEnv = process.env): Lang {
  return pickLang([env.EASY_STUDY_LANG ?? '']) ?? DEFAULT_LANG;
}

/** Runs `fn` (and the async work it starts) in `lang`: a resumed job in the language it was started in. */
export function runInLang<T>(lang: Lang, fn: () => T): T {
  return current.run(lang, fn);
}
