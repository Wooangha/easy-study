// English — server namespace `desktop` (the Korean reference: ../ko/desktop.ts).
import type { desktop as ko } from '../ko/desktop.ts';

export const desktop = {
  startup: {
    configError: (message) => `Configuration error: ${message}`,
    portInvalid: (raw) => `Invalid PORT value: "${raw}" (0–65535)`,
    libraryRequired: 'Desktop mode needs a library folder (EASY_STUDY_LIBRARY).',
    libraryLocked: (pid, port, library, lockFile) =>
      [
        `Another easy-study is already using this library folder (pid ${pid}, port ${port}).`,
        `  Library: ${library}`,
        "  Two servers sharing one folder would break each other's work, so this one didn't start.",
        '  Quit that easy-study (for example npm start in a terminal), or choose another library folder.',
        `  If no easy-study is running and you still see this, delete the lock file: ${lockFile}`,
      ].join('\n'),
    portInUse: (port) => `Couldn't start the server because another program is using port ${port}. Try opening the app again.`,
    libraryProblem: {
      EACCES: "You don't have permission to write to the library folder",
      EPERM: "You don't have permission to write to the library folder",
      EROFS: 'The library folder is read-only',
      EEXIST: "There's a file (not a folder) where the library folder should be",
      ENOTDIR: "There's a file (not a folder) in the library folder's path",
      EISDIR: "The library folder can't be written to",
      ENOENT: 'Library folder not found',
      ENOSPC: 'Not enough disk space to write to the library folder',
    },
    libraryFailed: (problem, code, library) => `${problem} (${code}): ${library}\n  Choose another library folder, or check this one.`,
    failed: (error) => `Couldn't start the server: ${error}`,
  },
  proxy: {
    unreachable: (origin) =>
      `Can't reach the connected computer (${origin}). Check that easy-study is running on it and that it's on the same network.`,
    wrongHost: "This address can't be opened here",
    badPath: 'Invalid request address',
    toMissing: 'No address to relay: --to http://host:port is required',
    portTaken: (port) => `Port ${port} is being used by another program`,
    startFailed: (error) => `Couldn't start the relay: ${error}`,
  },
} satisfies typeof ko;
