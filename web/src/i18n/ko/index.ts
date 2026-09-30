// Korean, the reference language: every namespace of the web client. Its shape is the type of every other language
// (`Messages`), so a text missing from or extra in a translation is a type error. See ../index.ts.
import { chat } from './chat.ts';
import { common } from './common.ts';
import { format } from './format.ts';
import { recording } from './recording.ts';
import { settings } from './settings.ts';
import { shell } from './shell.ts';
import { viewer } from './viewer.ts';

export const ko = { common, shell, chat, recording, viewer, settings, format };

export type Messages = typeof ko;
