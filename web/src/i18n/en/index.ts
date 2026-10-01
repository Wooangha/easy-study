// English: every namespace of the web client, each checked against the Korean one (see ../ko/index.ts).
import type { Messages } from '../ko/index.ts';
import { chat } from './chat.ts';
import { common } from './common.ts';
import { format } from './format.ts';
import { recording } from './recording.ts';
import { settings } from './settings.ts';
import { shell } from './shell.ts';
import { versions } from './versions.ts';
import { viewer } from './viewer.ts';

export const en: Messages = { common, shell, chat, recording, viewer, settings, format, versions };
