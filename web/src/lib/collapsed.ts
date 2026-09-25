// Which courses and groups of the library are collapsed (DESIGN §18): per device, in localStorage, and the same
// in every tab of the device. Each change is applied to what is stored at that moment (so it never overwrites
// what another tab changed), and other tabs' changes come in through `storage` events (reload()).
//
// No DOM or React here (unit-tested with a fake storage; web/src/hooks/useCollapsed.ts wires it up).

export interface KeyStorage {
  /** The stored keys: null when nothing is stored, undefined when storage cannot be used. */
  read(): string[] | null | undefined;
  write(keys: readonly string[]): void;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((key) => b.has(key));

export type CollapsedStore = ReturnType<typeof createCollapsedStore>;

export function createCollapsedStore(storage: KeyStorage) {
  let current: ReadonlySet<string> = new Set(storage.read() ?? []);
  /** Every course/group key this tab has seen exist. */
  const seen = new Set<string>();
  let synced = false;
  const listeners = new Set<() => void>();

  function show(next: ReadonlySet<string>) {
    if (sameSet(next, current)) return;
    current = next;
    for (const listener of listeners) listener();
  }

  /** Applies a change to the stored keys (this tab's, when storage cannot be used) and stores the result. */
  function change(apply: (keys: Set<string>) => void) {
    const stored = storage.read();
    const next = new Set(stored === undefined ? current : (stored ?? []));
    apply(next);
    storage.write([...next]);
    show(next);
  }

  return {
    getSnapshot: (): ReadonlySet<string> => current,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOne(key: string, value: boolean) {
      change((keys) => {
        if (value) keys.add(key);
        else keys.delete(key);
      });
    },
    toggle(key: string) {
      change((keys) => {
        if (!keys.delete(key)) keys.add(key);
      });
    },
    /** Collapse (or expand) every key given; other keys stay as they are. */
    setAll(given: readonly string[], value: boolean) {
      change((keys) => {
        for (const key of given) {
          if (value) keys.add(key);
          else keys.delete(key);
        }
      });
    },
    /** Another tab changed the stored keys. */
    reload() {
      const stored = storage.read();
      if (stored !== undefined) show(new Set(stored ?? []));
    },
    /**
     * The keys of the courses and groups that exist now: forget the collapse state of deleted ones. The first
     * list (just loaded) is complete, so every other key goes then; later only keys this tab saw disappear —
     * a course that another tab just created (and collapsed) may not be known here yet.
     */
    sync(existing: readonly string[]) {
      const known = new Set(existing);
      const gone = (key: string) => !known.has(key) && (!synced || seen.has(key));
      for (const key of existing) seen.add(key);
      if ([...current].some(gone)) {
        change((keys) => {
          for (const key of [...keys]) if (gone(key)) keys.delete(key);
        });
      }
      synced = true;
    },
  };
}
