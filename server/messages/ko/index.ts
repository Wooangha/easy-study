// Korean, the reference language: every namespace of the server's user-facing texts. Its shape is the type of every
// other language (`ServerMessages`), so a text missing from or extra in a translation is a type error. See ../../i18n.ts.
import { auth } from './auth.ts';
import { chat } from './chat.ts';
import { common } from './common.ts';
import { desktop } from './desktop.ts';
import { library } from './library.ts';
import { recordings } from './recordings.ts';

export const ko = { common, library, chat, recordings, auth, desktop };

export type ServerMessages = typeof ko;
