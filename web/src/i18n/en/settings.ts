// English — namespace `settings` (the Korean reference: ../ko/settings.ts).
import type { settings as ko } from '../ko/settings.ts';
import { rich } from '../rich.ts';

export const settings = {
  dialog: {
    closeTitle: 'Close (Esc)',
    nav: 'Settings sections',
    sections: {
      display: 'Display',
      study: 'Study',
      recording: 'Recording',
      desktop: 'Desktop app',
      about: 'About',
    },
  },

  display: {
    theme: 'Theme',
    themeOptions: {
      system: 'Use system setting',
      light: 'Light',
      dark: 'Dark',
    },
    themeHintApp: 'Applies to every screen of the app, the connection screen included.',
    language: 'Language',
    languageSystem: (current) => `Use system setting (${current})`,
    languageHintApp: "The menus and the connection screen follow your computer's language.",
    browserOnlyHint: 'Saved in this browser only.',
  },

  study: {
    neighbors: 'Neighboring slides sent with a question',
    neighborsNone: 'Current slide only',
    neighborsCount: (n) => (n === 1 ? '1 slide on each side' : `${n} slides on each side`),
    neighborsHint: 'The same setting as ‘Neighbors ±N’ in the chat panel.',
    annotations: 'Annotations',
    memosToTutor: 'Show your memos to the tutor',
    memosToTutorHint:
      'Memos on the current and neighboring slides are sent with each question. You can also turn this off for a single memo with its eye button (Show to tutor).',
    questionMarkers: 'Show question markers on slides',
    questionMarkersHint:
      'When you attach part of a slide to a question, that part is lightly shaded and a blue bar and a Q mark stay on its left. Attached annotations and memos get a blue dot on their corner. Click a marker to go to that question and its answer.',
  },

  recording: {
    asrStatusFailed: (error) => `Couldn't check the speech recognition status: ${error}`,
    showNoticeAgain: 'Show the recording notice again',
    noticeReset: "You'll see the notice again the next time you record.",
  },

  desktop: {
    updates: 'Updates',
    version: (version) => rich('Version ', version),
    releaseNotes: "What's new in the new version",
    checkUpdate: 'Check for updates',
    installAndRestart: 'Update and restart',
    openDownloadPage: 'Open download page',
    autoCheckOff: (icon) =>
      rich('Checking for a new version at startup is off (you can turn it on in ', icon, ' App settings on the connection screen).'),
    connection: 'Connection',
    connectedLocal: 'Connection: this computer',
    connectedRemote: (origin) => `Connection: another computer (${origin})`,
    connectedTo: (origin) => `Connection: ${origin}`,
    startupAuto: 'At startup: reconnect to the last connection right away',
    startupAsk: 'At startup: show the connection screen',
    changeConnection: 'Change connection…',
    askNextTime: 'Show the connection screen next time',
    askNextTimeDone: 'The connection screen will show first the next time you open the app.',
    menuHint: (keys) => rich('You can also change it from the menu Connection › Change connection… (', keys, ').'),
  },

  share: {
    title: 'Access from other devices',
    allow: 'Allow access from other devices (same network, access code required)',
    about:
      "Other computers and tablets on the same Wi‑Fi can use easy-study on this computer. Turning this on or off restarts this computer's server (the connection screen shows for a moment). Anyone with the code can ask questions with this computer's Claude/Codex and view and delete lecture files.",
    restartForAddresses: 'The addresses appear once the server restarts.',
    addresses: 'Addresses to open on other devices',
    noAddresses: "Couldn't find a network address. Connect to Wi‑Fi or Ethernet, then turn the switch off and on.",
    nameOnly: '(only when the name resolves on the same network)',
    copiedAddress: 'Copied the address.',
    code: 'Access code',
    copiedCode: 'Copied the access code.',
    showCode: 'Show',
    codeInChooser: (icon) => rich('(also under ', icon, ' App settings on the connection screen)'),
    resetCode: 'New access code (logs out every device)',
    networkHint:
      "If macOS or Windows asks whether ‘node’ may use the network, allow it (it's the server inside the app; an app you built yourself may ask every time you turn this on). On another computer, open it with the easy-study app's ‘Connect to another computer’ (recording works too) or in a browser. Recording in a tablet or phone browser needs HTTPS. Over http, someone on the same network can read or change what goes back and forth (a changed page can even use the microphone and the login): turn this on only on networks you trust, and use Tailscale or HTTPS anywhere else. If the Wi‑Fi changes and the addresses with it, turn this off and on.",
    restartConfirm: {
      title: 'Restart the server?',
      confirmLabel: 'Restart',
    },
  },

  about: {
    serverVersion: 'Server version',
    unknown: 'Unknown',
    appVersion: 'App version',
    libraryFolder: 'Library folder',
    copiedLibraryFolder: 'Copied the library folder path.',
    olderServer: 'This server is older than the app. Update it on the server computer.',
    shortcuts: 'Keyboard shortcuts',
    shortcutsHint: "Slide shortcuts work when you're not typing.",
    keys: {
      nextSlide: 'Next slide',
      previousSlide: 'Previous slide',
      firstLastSlide: 'First slide · last slide',
      focusComposer: 'Go to the message box',
      send: 'Send the question',
      newLine: 'New line',
      escape: 'Close a window · turn off the annotation tool · clear the selection',
      undo: 'Undo annotation',
      redo: 'Redo annotation',
      deleteSelected: 'Delete selected annotations',
      settings: 'Settings (app)',
      changeConnection: 'Change connection (app)',
    },
  },

  copyFailed: "Couldn't copy.",

  bridge: {
    leave: {
      title: 'Change the connection?',
      confirmLabel: 'Change',
      recording:
        "A lecture is being recorded. Changing stops the recording (what's recorded so far is saved and finishes uploading when you reconnect to the same server).",
      unsent:
        "Recorded audio is still being sent to the server. Changing stops it (it's saved on this device and finishes uploading when you reconnect to the same server).",
      busy: "An answer is being written or a file is uploading. If you change now, you won't see the result on this screen.",
    },
    installBlocked: {
      recording: "Can't install while recording — finish the recording first.",
      unsent: "Recorded audio is being sent to the server — you can install once it's sent.",
      uploads: "A recording file is uploading — you can install once it's done.",
    },
    installWarning: 'An answer is being written or a file is uploading. Restarting stops it. Install anyway?',
    shareBlocked: {
      recording: "Can't change this while recording — finish the recording first.",
      unsent: "Recorded audio is being sent to the server — you can change this once it's sent.",
      uploads: "A recording file is uploading — you can change this once it's done.",
    },
    shareWarning: 'An answer is being written or a file is uploading. Restarting the server stops it. Change anyway?',
    resetCode: {
      title: 'Make a new access code?',
      message:
        "Every other device logged in with the current code will be logged out. This computer's server restarts once to make the new code.",
      busy: 'An answer is being written or a file is uploading. Restarting the server stops it.',
      confirmLabel: 'Make new code',
    },
    status: {
      checking: 'Checking…',
      available: (version) => `easy-study ${version} is available`,
      downloading: 'Downloading…',
      downloadingPercent: (percent) => `Downloading… ${percent}%`,
      downloaded: (version) => `easy-study ${version} is downloaded`,
      installing: (version) => `Installing easy-study ${version}…`,
      latest: "You're up to date",
      lastCheckFailed: (error) => `Last check failed: ${error}`,
      notChecked: 'Not checked yet',
    },
    downloadPackage: (pkg, arch) =>
      `With this install type (${pkg}), download and install the new package.${arch ? " (makepkg -si with the release's PKGBUILD)" : ''}`,
    downloadPage: 'Download and install the new version from the download page.',
    macMicFix: "If recording doesn't work, turn easy-study off and on in System Settings › Privacy & Security › Microphone.",
    macMicHint: 'macOS may ask for microphone permission again the first time you record after an update.',
    updated: (version) => `Updated to easy-study ${version}.`,
    updateFailed: (error) => `Couldn't update: ${error}`,
  },
} satisfies typeof ko;
