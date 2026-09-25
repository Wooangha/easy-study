// Which courses and groups of the library are collapsed (DESIGN §18): per device, in localStorage, kept in step
// across the tabs of the device (lib/collapsed.ts).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createCollapsedStore } from '../lib/collapsed.ts';
import { isStringArray } from '../lib/libraryLayout.ts';
import { readStored, storageItemName, storageKeys, writeStorage } from '../lib/storage.ts';

/** `existingKeys`: every course/group key once the library is known (null before), to forget deleted ones. */
export function useCollapsed(existingKeys: readonly string[] | null) {
  const [store] = useState(() =>
    createCollapsedStore({
      read: () => readStored(storageKeys.collapsed, isStringArray),
      write: (keys) => writeStorage(storageKeys.collapsed, keys.length > 0 ? keys : null),
    }),
  );
  const collapsed = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    const name = storageItemName(storageKeys.collapsed);
    const onStorage = (e: StorageEvent) => {
      if (e.key === name || e.key === null) store.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);

  useEffect(() => {
    if (existingKeys) store.sync(existingKeys);
  }, [store, existingKeys]);

  return { collapsed, setOne: store.setOne, toggle: store.toggle, setAll: store.setAll };
}
