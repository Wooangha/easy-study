// English — server namespace `auth` (the Korean reference: ../ko/auth.ts).
import type { auth as ko } from '../ko/auth.ts';

export const auth = {
  codeRequired: 'Enter the access code',
  codeTooLong: 'The access code is too long',
  codeInvalid: 'The access code is incorrect',
  tooManyAttempts: (minutes) =>
    `Too many login attempts. Try again in ${minutes === 1 ? '1 minute' : `${minutes} minutes`}`,
} satisfies typeof ko;
