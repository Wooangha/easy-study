// Rich text in messages (DESIGN §27): a message with elements inside (a <strong>, a <code>, an icon) is a function of
// those elements that returns the pieces in order as one fragment, so each language puts them where its sentence
// needs them:
//
//   ko: codeHint: (cmd: ReactNode) => rich('터미널에서 ', cmd, '을 실행하세요'),
//   en: codeHint: (cmd) => rich('Run ', cmd, ' in a terminal'),
//   use: {m.codeHint(<code>npm start</code>)}
//
// Message files import this file (not ../index.ts, which imports them).
import { createElement, Fragment, type ReactNode } from 'react';

export function rich(...parts: ReactNode[]): ReactNode {
  return createElement(Fragment, null, ...parts);
}
