// Tags of a memo (DESIGN §25): chips plus an input; Enter or a comma adds, Backspace on an empty input removes the
// last one; suggestions come from this lecture's tags and the library's (asked at most once a minute while a tag
// input has the focus), in a small list steered with ↑/↓/Enter. Plain text only.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { MAX_MEMO_TAGS } from '../../../../shared/types.ts';
import { normalizeTag, suggestTags } from '../../lib/annotations/geometry.ts';
import { fetchLibraryTags } from '../../lib/annotations/store.ts';
import { Floating } from './Floating.tsx';

const SUGGESTIONS_WIDTH = 180;

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** This lecture's tags (the summary's). */
  lectureTags: ReadonlyArray<{ tag: string; count: number }>;
  disabled?: boolean;
}

export function TagInput({ tags, onChange, lectureTags, disabled = false }: TagInputProps) {
  const [typed, setTyped] = useState('');
  const [focused, setFocused] = useState(false);
  const [libraryTags, setLibraryTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null);
  const setInputRef = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el;
    setInputEl(el);
  }, []);
  const listId = useId();
  const blurInput = useCallback(() => inputRef.current?.blur(), []);

  useEffect(() => {
    if (!focused) return;
    let alive = true;
    void fetchLibraryTags().then((list) => {
      if (alive) setLibraryTags(list);
    });
    return () => {
      alive = false;
    };
  }, [focused]);

  const full = tags.length >= MAX_MEMO_TAGS;
  const suggestions = focused && !full ? suggestTags(typed, [...lectureTags, ...libraryTags], tags) : [];

  const add = (raw: string) => {
    const tag = normalizeTag(raw);
    setTyped('');
    setActive(-1);
    if (!tag || tags.includes(tag) || full) return;
    onChange([...tags, tag]);
  };

  const remove = (tag: string) => onChange(tags.filter((t) => t !== tag));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME (Korean) composition
    if (e.key === 'ArrowDown' && suggestions.length > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(active >= 0 && suggestions[active] ? suggestions[active] : typed);
    } else if (e.key === 'Backspace' && typed === '' && tags.length > 0) {
      e.preventDefault();
      remove(tags[tags.length - 1]);
    } else if (e.key === 'Escape') {
      if (typed !== '') {
        e.preventDefault();
        e.stopPropagation();
        setTyped('');
        setActive(-1);
      }
    }
  };

  return (
    <div className={focused ? 'tag-input is-focused' : 'tag-input'} onClick={() => inputRef.current?.focus()}>
      {tags.map((tag) => (
        <span key={tag} className="memo-tag">
          #{tag}
          {!disabled && (
            <button type="button" className="memo-tag-x" onClick={() => remove(tag)} aria-label={`태그 ${tag} 빼기`} title="태그 빼기">
              <X size="1em" />
            </button>
          )}
        </span>
      ))}
      {!disabled && !full && (
        <input
          ref={setInputRef}
          className="tag-input-field"
          value={typed}
          placeholder={tags.length === 0 ? '태그 추가…' : ''}
          aria-label="태그 추가"
          aria-autocomplete="list"
          aria-controls={suggestions.length > 0 ? listId : undefined}
          aria-expanded={suggestions.length > 0}
          maxLength={40}
          onChange={(e) => {
            setTyped(e.target.value);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (typed.trim() !== '') add(typed);
          }}
        />
      )}
      {suggestions.length > 0 && (
        <Floating anchor={inputEl} width={SUGGESTIONS_WIDTH} height={160} className="tag-suggestions-wrap" onScrollAway={blurInput}>
          <ul id={listId} className="tag-suggestions" role="listbox">
            {suggestions.map((tag, i) => (
              <li
                key={tag}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'tag-suggestion is-active' : 'tag-suggestion'}
                // Before the input's blur (which would add the typed text).
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(tag);
                }}
              >
                #{tag}
              </li>
            ))}
          </ul>
        </Floating>
      )}
    </div>
  );
}
