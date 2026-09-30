// English: every namespace of the server's user-facing texts, each checked against the Korean one (../ko/index.ts).
import type { ServerMessages } from '../ko/index.ts';
import { auth } from './auth.ts';
import { chat } from './chat.ts';
import { common } from './common.ts';
import { desktop } from './desktop.ts';
import { library } from './library.ts';
import { recordings } from './recordings.ts';

export const en: ServerMessages = { common, library, chat, recordings, auth, desktop };
