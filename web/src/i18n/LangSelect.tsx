// The language picker (DESIGN §27): 설정 › 화면 and the screens before a login. 시스템 설정 따르기 names the language it
// resolves to; the languages are shown in their own language, so anyone can find theirs.
import { LANGS, isLangPref, msg, setLang, systemLang, useLangPref } from './index.ts';

export function LangSelect({ id, className = 'picker' }: { id?: string; className?: string }) {
  const pref = useLangPref();
  const m = msg().settings.display;
  const system = LANGS.find((l) => l.id === systemLang())?.native ?? '';
  return (
    <select
      id={id}
      className={className}
      value={pref}
      aria-label={id ? undefined : m.language}
      onChange={(e) => {
        if (isLangPref(e.target.value)) setLang(e.target.value);
      }}
    >
      <option value="system">{m.languageSystem(system)}</option>
      {LANGS.map((l) => (
        <option key={l.id} value={l.id} lang={l.id}>
          {l.native}
        </option>
      ))}
    </select>
  );
}
