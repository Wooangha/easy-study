// Korean (the reference language) — server namespace `auth`: the login (remote mode): errors of the login routes and the local-only refusal.

export const auth = {
  codeRequired: '접속 코드를 입력해 주세요',
  codeTooLong: '접속 코드가 너무 깁니다',
  codeInvalid: '접속 코드가 올바르지 않습니다',
  tooManyAttempts: (minutes: number) => `로그인 시도가 너무 많습니다. ${minutes}분 뒤에 다시 시도해 주세요`,
};
