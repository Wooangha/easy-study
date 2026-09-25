// Korean particles that depend on whether the word before them ends in a final consonant (받침).

/** Final consonant of the last character: true/false for Hangul syllables and digits, null when unknown. */
function endsInConsonant(word: string): boolean | null {
  const last = word.trim().replace(/[\s’'"”)\]}.!?]+$/u, '').slice(-1);
  if (!last) return null;
  const code = last.charCodeAt(0) - 0xac00;
  if (code >= 0 && code <= 11171) return code % 28 !== 0;
  // 0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔 end in a consonant; 2 이, 4 사, 5 오, 9 구 do not.
  if (/[0-9]/.test(last)) return '013678'.includes(last);
  return null;
}

/**
 * `word` followed by the right particle: withParticle('강의', '을', '를') → '강의를', '과목' → '과목을',
 * "‘Lecture 7’" → "‘Lecture 7’을". Unknown endings (Latin letters…) get both forms: 'OS을(를)'.
 */
export function withParticle(word: string, afterConsonant: string, afterVowel: string): string {
  const consonant = endsInConsonant(word);
  if (consonant === null) return `${word}${afterConsonant}(${afterVowel})`;
  return word + (consonant ? afterConsonant : afterVowel);
}
