//! The shell's language (DESIGN §27). The menus, the native dialogs, the chooser page (ui/texts.js) and every text
//! the shell hands to a page (the chooser's status lines, the update state) follow the operating system's language:
//! the first of the user's preferred languages the app has (Korean or English), English when the OS names only
//! others, Korean when it names none (as the web client's "시스템 설정 따르기", shared/i18n.ts pickLang). It is read
//! once per launch. The web client's own setting is per origin (the page's localStorage) and never changes the
//! shell's; pages learn the shell's language from the marker (bridge::INIT_SCRIPT `lang`).
//!
//! Texts: one `Texts` value per language, i18n/ko.rs (the reference) and i18n/en.rs: a text missing in one of them
//! is a compile error. A text with values is a function (`fn(&str) -> String`, …), so each language builds its own
//! sentence (word order, plurals). Read them where they are used (`i18n::msg().update.network`).
//! Not translated: log lines (shell.log, server.log, the smoke run's output), what the shell matches in the server's
//! own output (server.rs PORT_TAKEN_MARK: the server's terminal output stays Korean), names (easy-study, Node.js,
//! commands, environment variables, file names).
//!
//! Tests run in Korean, like the web client's and the server's: a per-thread language, `with_lang` for English.

mod en;
mod ko;

/// A language of the shell (shared/i18n.ts `Lang`). To add one: a variant here, a match arm in `of_tag`, `id` and
/// `msg`, and an i18n/<id>.rs with every text (the compiler lists what is missing), plus ui/texts.js.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Ko,
    En,
}

impl Lang {
    /// The id the pages use ("ko", "en": shared/i18n.ts, the chooser's texts.js).
    pub fn id(self) -> &'static str {
        match self {
            Lang::Ko => "ko",
            Lang::En => "en",
        }
    }

    /// The language of a BCP 47 tag or a POSIX locale name ("ko-KR", "en_US.UTF-8", "ko"), if the shell has it.
    pub fn of_tag(tag: &str) -> Option<Lang> {
        let lower = tag.trim().to_ascii_lowercase();
        match lower.split(['-', '_', '.', '@', ';']).next().unwrap_or_default() {
            "ko" => Some(Lang::Ko),
            "en" => Some(Lang::En),
            _ => None,
        }
    }
}

/// When the OS names no language at all.
pub const DEFAULT: Lang = Lang::Ko;
/// When it names only languages the shell does not have.
pub const FALLBACK: Lang = Lang::En;

/// The language for the user's languages, most preferred first (shared/i18n.ts pickLang).
pub fn pick(tags: &[String]) -> Lang {
    let real: Vec<&str> = tags.iter().map(|t| t.trim()).filter(|t| !t.is_empty() && *t != "*").collect();
    real.iter().find_map(|t| Lang::of_tag(t)).unwrap_or(if real.is_empty() { DEFAULT } else { FALLBACK })
}

/// The texts of the shell's language.
pub fn msg() -> &'static Texts {
    texts(lang())
}

pub fn texts(lang: Lang) -> &'static Texts {
    match lang {
        Lang::Ko => &ko::TEXTS,
        Lang::En => &en::TEXTS,
    }
}

/// Every language's texts (tests: the same checks for each).
#[cfg(test)]
pub const ALL: [Lang; 2] = [Lang::Ko, Lang::En];

// ---------------------------------------------------------------------------------------------------------
// The OS's language
// ---------------------------------------------------------------------------------------------------------

static DETECTED: std::sync::OnceLock<(Lang, Vec<String>)> = std::sync::OnceLock::new();

fn detected() -> &'static (Lang, Vec<String>) {
    DETECTED.get_or_init(|| {
        let tags = os_languages();
        (pick(&tags), tags)
    })
}

/// The shell's language: the OS's, read once.
#[cfg(not(test))]
pub fn lang() -> Lang {
    detected().0
}

/// For shell.log: the language and what the OS said ("en (en-US, ja-JP)").
pub fn describe() -> String {
    let (lang, tags) = detected();
    let shown: Vec<&str> = tags.iter().take(4).map(String::as_str).collect();
    format!("{} ({})", lang.id(), if shown.is_empty() { "none".to_string() } else { shown.join(", ") })
}

/// macOS: the user's preferred languages (System Settings › General › Language & Region, or the app's own language
/// there), most preferred first.
#[cfg(target_os = "macos")]
fn os_languages() -> Vec<String> {
    use std::ffi::{c_char, c_void, CStr};
    type CFIndex = isize;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFLocaleCopyPreferredLanguages() -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> CFIndex;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: CFIndex) -> *const c_void;
        fn CFStringGetCString(string: *const c_void, buffer: *mut c_char, size: CFIndex, encoding: u32) -> u8;
        fn CFRelease(cf: *const c_void);
    }
    const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8
    let mut tags = Vec::new();
    // SAFETY: CoreFoundation's documented use. The array is owned here (a Copy function) and released once; its
    // elements are CFStrings it keeps alive until then; the buffer is NUL-terminated by CFStringGetCString on success.
    unsafe {
        let array = CFLocaleCopyPreferredLanguages();
        if array.is_null() {
            return tags;
        }
        for i in 0..CFArrayGetCount(array) {
            let tag = CFArrayGetValueAtIndex(array, i);
            let mut buffer = [0 as c_char; 128];
            if !tag.is_null() && CFStringGetCString(tag, buffer.as_mut_ptr(), buffer.len() as CFIndex, UTF8) != 0 {
                tags.push(CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into_owned());
            }
        }
        CFRelease(array);
    }
    tags
}

/// Windows: the user's display languages, most preferred first ("ko-KR", "en-US").
#[cfg(windows)]
fn os_languages() -> Vec<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserPreferredUILanguages(flags: u32, count: *mut u32, buffer: *mut u16, size: *mut u32) -> i32;
    }
    const MUI_LANGUAGE_NAME: u32 = 0x8;
    let (mut count, mut size) = (0u32, 0u32);
    // SAFETY: the documented two calls: the size first (a null buffer), then a buffer of that many UTF-16 units,
    // which receives NUL-separated names ending in an empty one.
    unsafe {
        if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, std::ptr::null_mut(), &mut size) == 0 || size == 0 {
            return Vec::new();
        }
        let mut buffer = vec![0u16; size as usize];
        if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, buffer.as_mut_ptr(), &mut size) == 0 {
            return Vec::new();
        }
        buffer.split(|&c| c == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
    }
}

/// Linux (and other Unixes): the locale of the messages, as gettext reads it — LANGUAGE (a list) unless the locale
/// is C, then LC_ALL, LC_MESSAGES, LANG. No locale at all is C (English).
#[cfg(not(any(target_os = "macos", windows)))]
fn os_languages() -> Vec<String> {
    locale_languages(|name| std::env::var(name).ok())
}

/// The language tags of a POSIX environment (`var` reads a variable).
#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
fn locale_languages(var: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let set = |name: &str| var(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let locale = set("LC_ALL").or_else(|| set("LC_MESSAGES")).or_else(|| set("LANG")).unwrap_or_else(|| "C".into());
    let c = locale == "C" || locale == "POSIX" || locale.starts_with("C.");
    let mut tags: Vec<String> = Vec::new();
    if !c {
        tags.extend(set("LANGUAGE").iter().flat_map(|l| l.split(':')).map(str::trim).filter(|t| !t.is_empty()).map(str::to_string));
    }
    tags.push(locale);
    tags
}

// ---------------------------------------------------------------------------------------------------------
// Tests: Korean unless a test says otherwise (per thread: tests run in parallel)
// ---------------------------------------------------------------------------------------------------------

#[cfg(test)]
thread_local! {
    static TEST_LANG: std::cell::Cell<Lang> = const { std::cell::Cell::new(Lang::Ko) };
}

#[cfg(test)]
pub fn lang() -> Lang {
    TEST_LANG.with(|l| l.get())
}

/// Runs `f` with the shell in `lang` (this thread only).
#[cfg(test)]
pub fn with_lang<R>(lang: Lang, f: impl FnOnce() -> R) -> R {
    let before = TEST_LANG.with(|l| l.replace(lang));
    let result = f();
    TEST_LANG.with(|l| l.set(before));
    result
}

// ---------------------------------------------------------------------------------------------------------
// The texts
// ---------------------------------------------------------------------------------------------------------

pub struct Texts {
    pub common: Common,
    /// The menu bar (main.rs build_menu) and its items' texts.
    pub menu: Menu,
    /// Menu "연결 대상 바꾸기…" / "새로 고침" while the page records (main.rs leave_page).
    pub leave: Leave,
    /// The chooser's library folder (main.rs pick_library, set_library).
    pub library: Library,
    /// What the chooser shows at launch (main.rs setup).
    pub launch: Launch,
    /// This computer's server (server.rs).
    pub server: Server,
    /// The loopback relay for plain-http remote servers (proxy.rs).
    pub relay: Relay,
    /// Checking another computer's server (remote.rs).
    pub remote: Remote,
    /// The busy check before a restart (bridge.rs decide_for).
    pub busy: Busy,
    /// Dialogs for a page's actions (bridge.rs).
    pub page: Page,
    /// "다른 기기에서 접속 허용" (share.rs).
    pub share: Share,
    /// In-app updates (update.rs).
    pub update: Update,
}

pub struct Common {
    pub ok: &'static str,
    pub cancel: &'static str,
    pub close: &'static str,
    /// Nothing connects or changes while an update replaces the app.
    pub installing_update: &'static str,
    pub unknown_theme: fn(&str) -> String,
    /// (error)
    pub no_resource_dir: fn(&str) -> String,
    /// (path)
    pub no_node: fn(&str) -> String,
    /// How a process ended (server.rs describe).
    pub exit_code: fn(i32) -> String,
    pub exit_signal: fn(i32) -> String,
    pub exit_unknown: &'static str,
}

/// (Some items exist on macOS only, `quit` elsewhere only.)
#[allow(dead_code)]
pub struct Menu {
    pub choose: &'static str,
    pub reload: &'static str,
    pub open_browser: &'static str,
    pub open_library: &'static str,
    pub settings: &'static str,
    pub check_update: &'static str,
    /// (version) The item once a version is found.
    pub install_update: fn(&str) -> String,
    /// (app name) macOS.
    pub quit_app: fn(&str) -> String,
    /// Windows and Linux.
    pub quit: &'static str,
    pub about: fn(&str) -> String,
    pub services: &'static str,
    pub hide: fn(&str) -> String,
    pub hide_others: &'static str,
    pub show_all: &'static str,
    pub edit: &'static str,
    pub undo: &'static str,
    pub redo: &'static str,
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub connection: &'static str,
    pub window: &'static str,
    pub minimize: &'static str,
    pub zoom: &'static str,
    pub fullscreen: &'static str,
    pub close_window: &'static str,
}

pub struct Leave {
    pub choose_recording: &'static str,
    pub choose: &'static str,
    pub reload_recording: &'static str,
    pub reload: &'static str,
}

pub struct Library {
    /// The folder picker's title.
    pub pick_title: &'static str,
    /// (error)
    pub unreadable: fn(&str) -> String,
    /// (folder name)
    pub not_a_library: fn(&str) -> String,
    /// (variable)
    pub from_env: fn(&str) -> String,
    /// (path)
    pub not_a_folder: fn(&str) -> String,
    /// (path, error)
    pub not_writable: fn(&str, &str) -> String,
    pub changed_stopping: &'static str,
    pub changed: &'static str,
}

pub struct Launch {
    pub crashed: &'static str,
    /// (the saved server's address)
    pub connecting: fn(&str) -> String,
    /// (why)
    pub saved_failed: fn(&str) -> String,
}

pub struct Server {
    pub starting: &'static str,
    /// (path)
    pub no_entry: fn(&str) -> String,
    /// (path, error)
    pub no_library: fn(&str, &str) -> String,
    /// (error, node's path)
    pub spawn_failed: fn(&str, &str) -> String,
    /// (seconds)
    pub not_ready: fn(u64) -> String,
    /// (how it ended)
    pub exited: fn(&str) -> String,
    pub not_started: fn(&str) -> String,
}

pub struct Relay {
    pub missing: &'static str,
    pub no_port: &'static str,
    /// (error)
    pub spawn_failed: fn(&str) -> String,
    /// (how it ended, its last line)
    pub not_started: fn(&str, &str) -> String,
    /// (seconds)
    pub not_ready: fn(u64) -> String,
    /// (how it ended)
    pub exited: fn(&str) -> String,
}

pub struct Remote {
    /// (example address)
    pub enter_address: fn(&str) -> String,
    pub bad_address: fn(&str) -> String,
    pub http_only: &'static str,
    pub no_host: fn(&str) -> String,
    pub no_credentials: &'static str,
    /// (host)
    pub unresolved: fn(&str) -> String,
    pub unresolved_short: fn(&str) -> String,
    /// (host, or "host(ip)")
    pub public_http: fn(&str) -> String,
    /// (error)
    pub no_tls: fn(&str) -> String,
    /// (header name)
    pub bad_header: fn(&str) -> String,
    /// (host, port, error)
    pub send_failed: fn(&str, u16, &str) -> String,
    pub receive_failed: fn(&str, u16, &str) -> String,
    /// (host, port)
    pub not_http: fn(&str, u16) -> String,
    pub connect_failed: fn(&str, u16) -> String,
    /// Added to connect_failed on macOS when the local network looks blocked (a leading space).
    pub local_network: &'static str,
    /// (host, port, error)
    pub not_https: fn(&str, u16, &str) -> String,
    /// (host, error)
    pub untrusted: fn(&str, &str) -> String,
    /// (host, port, error)
    pub tls_failed: fn(&str, u16, &str) -> String,
    /// (origin, where it redirects)
    pub redirected: fn(&str, &str) -> String,
    /// (origin, HTTP status)
    pub not_easy_study: fn(&str, u16) -> String,
}

pub struct Busy {
    pub block_recording: &'static str,
    pub block_unsent: &'static str,
    pub block_recording_share: &'static str,
    pub block_unsent_share: &'static str,
    /// The question after the list (install, share restart).
    pub warn_install: &'static str,
    pub warn_share: &'static str,
    /// The list's lines.
    pub answering: &'static str,
    pub uploading: &'static str,
    pub page_unknown: &'static str,
    /// (lecture, recording title)
    pub recording_named: fn(&str, &str) -> String,
    pub recording: &'static str,
    /// (count)
    pub transcribing: fn(u64) -> String,
    pub digesting: &'static str,
    /// (count) Other windows' answers while this page makes one.
    pub answers_elsewhere: fn(u64) -> String,
    pub answers: fn(u64) -> String,
    pub model_download: &'static str,
    pub server_unknown: &'static str,
}

pub struct Page {
    pub confirm_reveal: &'static str,
    pub reveal: &'static str,
    pub confirm_choose: &'static str,
    pub choose: &'static str,
    pub confirm_forget: &'static str,
    pub forget: &'static str,
    pub confirm_cancel_download: &'static str,
    pub cancel_download: &'static str,
    pub keep_downloading: &'static str,
}

pub struct Share {
    pub starting: &'static str,
    pub restarting: &'static str,
    pub confirm_on: &'static str,
    pub allow: &'static str,
    pub restart: &'static str,
}

pub struct Update {
    // The fixed error texts (update.rs describe): never an error's own text (paths, user names).
    pub network: &'static str,
    pub no_file: &'static str,
    pub signature: &'static str,
    pub wrong_file: &'static str,
    pub mac_permission: &'static str,
    pub appimage_permission: &'static str,
    pub installer: &'static str,
    pub other: &'static str,
    // Why this copy updates from the release page.
    pub reason_move_app: &'static str,
    pub reason_extracted: &'static str,
    pub reason_deb: &'static str,
    pub reason_rpm: &'static str,
    pub reason_arch: &'static str,
    pub reason_installer: &'static str,
    pub reason_dev: &'static str,
    /// (version) The chooser's busy line.
    pub installing: fn(&str) -> String,
    /// (this version) The update of the last launch did not take.
    pub did_not_take: fn(&str) -> String,
    /// How the texts that say "the update failed" themselves begin (did_not_take, other): no prefix goes before them
    /// (update.rs says_update_failed; the chooser's and the web client's errorText know them too).
    pub failed_prefixes: &'static [&'static str],
    /// (text)
    pub failed: fn(&str) -> String,
    pub could_not_check: fn(&str) -> String,
    /// (this version)
    pub latest: fn(&str) -> String,
    pub still_checking: &'static str,
    /// (version)
    pub downloading: fn(&str) -> String,
    pub preparing: &'static str,
    /// (found version, this version)
    pub available: fn(&str, &str) -> String,
    pub install_now: &'static str,
    /// (version) Another computer's page asked to install.
    pub confirm_install: fn(&str) -> String,
    pub install_restart: &'static str,
    pub later: &'static str,
    pub open_download: &'static str,
    /// (why it waits) The download is kept for later.
    pub kept_download: fn(&str) -> String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_follow_the_users_list() {
        let tags = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(pick(&tags(&["ko-KR", "en-US"])), Lang::Ko);
        assert_eq!(pick(&tags(&["en-US", "ko-KR"])), Lang::En);
        assert_eq!(pick(&tags(&["ko"])), Lang::Ko);
        assert_eq!(pick(&tags(&["ko-Kore-KR"])), Lang::Ko);
        // The first language the shell has, then English; nothing at all: Korean.
        assert_eq!(pick(&tags(&["ja-JP", "ko-KR"])), Lang::Ko);
        assert_eq!(pick(&tags(&["ja-JP", "zh-Hans"])), Lang::En);
        assert_eq!(pick(&tags(&[])), Lang::Ko);
        assert_eq!(pick(&tags(&["", " ", "*"])), Lang::Ko);
        // POSIX locale names.
        assert_eq!(pick(&tags(&["ko_KR.UTF-8"])), Lang::Ko);
        assert_eq!(pick(&tags(&["en_US@euro"])), Lang::En);
        assert_eq!(pick(&tags(&["C.UTF-8"])), Lang::En);
        assert_eq!(Lang::of_tag("KO-kr"), Some(Lang::Ko));
        assert_eq!(Lang::of_tag("kok"), None, "Konkani is not Korean");
        assert_eq!((Lang::Ko.id(), Lang::En.id()), ("ko", "en"));
    }

    #[test]
    fn posix_locales_are_read_like_gettext() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |name: &str| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string());
        assert_eq!(locale_languages(env(&[("LANG", "ko_KR.UTF-8")])), ["ko_KR.UTF-8"]);
        assert_eq!(locale_languages(env(&[("LANG", "en_US.UTF-8"), ("LC_MESSAGES", "ko_KR.UTF-8")])), ["ko_KR.UTF-8"]);
        assert_eq!(locale_languages(env(&[("LANG", "ko_KR.UTF-8"), ("LC_ALL", "en_GB.UTF-8")])), ["en_GB.UTF-8"]);
        assert_eq!(locale_languages(env(&[("LANG", "en_US.UTF-8"), ("LANGUAGE", "ko:en")])), ["ko", "en", "en_US.UTF-8"]);
        // LANGUAGE does not count in the C locale; no locale at all is C.
        assert_eq!(locale_languages(env(&[("LANG", "C.UTF-8"), ("LANGUAGE", "ko")])), ["C.UTF-8"]);
        assert_eq!(locale_languages(env(&[])), ["C"]);
        assert_eq!(pick(&locale_languages(env(&[]))), Lang::En);
    }

    #[test]
    fn tests_run_in_korean_unless_told() {
        assert_eq!(lang(), Lang::Ko);
        assert_eq!(msg().common.cancel, "취소");
        assert_eq!(with_lang(Lang::En, || msg().common.cancel), "Cancel");
        assert_eq!(lang(), Lang::Ko);
    }

    /// Every language's own grammar: counts, and no Korean left in another language's texts (sampled through the
    /// functions; en.rs itself is checked for Hangul by desktop/scripts/i18n.test.mjs).
    #[test]
    fn english_texts_are_english() {
        let en = texts(Lang::En);
        assert_eq!((en.busy.transcribing)(1), "Transcribing 1 recording.");
        assert_eq!((en.busy.transcribing)(3), "Transcribing 3 recordings.");
        assert_eq!((en.busy.answers)(1), "Writing 1 answer.");
        assert_eq!((en.busy.answers_elsewhere)(2), "Writing 2 answers in other windows.");
        assert_eq!((en.server.not_ready)(90), "The easy-study server on this computer wasn't ready within 90 seconds, so it was stopped.");
        let hangul = |s: &str| s.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c) || ('\u{3131}'..='\u{318E}').contains(&c));
        let samples = [
            (en.menu.quit_app)("easy-study"),
            (en.library.not_a_library)("docs"),
            (en.remote.connect_failed)("192.168.0.10", 5180),
            (en.update.available)("0.7.0", "0.6.6"),
            (en.busy.recording_named)("OS week 3", "Monday"),
        ];
        for s in samples {
            assert!(!hangul(&s), "{s}");
        }
        assert!(en.failed_prefixes_cover_their_texts());
    }

    impl Texts {
        /// The texts that say "the update failed" themselves start with one of failed_prefixes; the texts that need
        /// a prefix do not.
        fn failed_prefixes_cover_their_texts(&self) -> bool {
            let says = |t: &str| self.update.failed_prefixes.iter().any(|p| t.starts_with(p));
            says(&(self.update.did_not_take)("0.5.0"))
                && says(self.update.other)
                && ![
                    self.update.network,
                    self.update.no_file,
                    self.update.signature,
                    self.update.wrong_file,
                    self.update.mac_permission,
                    self.update.appimage_permission,
                    self.update.installer,
                ]
                .iter()
                .any(|t| says(t))
        }
    }

    #[test]
    fn every_language_marks_its_self_contained_update_failures() {
        for lang in ALL {
            assert!(texts(lang).failed_prefixes_cover_their_texts(), "{lang:?}");
        }
    }
}
