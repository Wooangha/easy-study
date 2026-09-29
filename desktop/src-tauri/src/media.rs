//! The microphone for the lecture recorder (DESIGN §22). The web client records in the app window itself:
//! getUserMedia → AudioContext(16 kHz) → AudioWorklet → PCM uploads to its server. What each WebView needs for that
//! (rec-live spike, key `web`):
//! - macOS (WKWebView): no code. wry's UI delegate grants capture requests; Info.plist carries
//!   NSMicrophoneUsageDescription (without it WKWebView has no navigator.mediaDevices at all) and app.entitlements
//!   com.apple.security.device.audio-input (the app runs with the hardened runtime, even ad-hoc signed). macOS asks
//!   the user once (TCC) and remembers the answer for the app.
//! - Linux (WebKitGTK): wry leaves media capture to WebKit's defaults, and those deny every request
//!   (NotAllowedError): enable-media-stream is switched on and a permission-request handler allows audio capture —
//!   never video or the screen — for the trusted origins below.
//! - Windows (WebView2): wry answers only clipboard requests, so WebView2 would ask with its own prompt naming
//!   "127.0.0.1:<port>" (and could remember a "no"): the microphone is allowed for the trusted origins and denied
//!   for any other page, the camera is always denied, everything else keeps WebView2's default.
//!
//! Trusted: the page is the one the main window may show (`allowed_origin`), and that is a loopback origin the
//! shell itself runs — this computer's server (http://127.0.0.1:<port>, a secure context) or its relay for a
//! plain-http server on another computer (proxy.rs, the same kind of origin) — or a server the user connected to
//! over https. A plain-http page on another computer, shown directly, is no secure context: the browser engine
//! hides getUserMedia there anyway (which is what the relay is for).

use tauri::{AppHandle, Url};

#[cfg(any(target_os = "linux", windows))]
use crate::{
    config::{self, lock},
    AppState,
};
#[cfg(any(target_os = "linux", windows))]
use tauri::Manager;

// macOS needs no handler: the policy is only used (and unit-tested everywhere) for Linux and Windows.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// Whether the page at `page` (the requesting document's URL) may capture audio: it is the main window's
/// `allowed_origin`, and that is the loopback origin the shell runs (`local_server`: its server's URL, or its
/// relay's) or an https origin.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
pub fn audio_capture_allowed(page: &str, allowed_origin: Option<&str>, local_server: Option<&str>) -> bool {
    let Ok(url) = Url::parse(page) else { return false };
    if !matches!(url.scheme(), "http" | "https") {
        return false; // the chooser (tauri://, http://tauri.localhost), about:blank, data:, blob:…
    }
    let page_origin = origin(&url);
    if allowed_origin != Some(page_origin.as_str()) {
        return false;
    }
    let local = local_server.and_then(|u| Url::parse(u).ok()).is_some_and(|u| origin(&u) == page_origin);
    local || url.scheme() == "https"
}

/// audio_capture_allowed with the app's current state: the loopback origin the shell itself runs is its server
/// or, while a plain-http remote is shown through it, its relay (the main window shows one of them at a time).
#[cfg(any(target_os = "linux", windows))]
fn allowed(app: &AppHandle, page: &str) -> bool {
    let st = app.state::<AppState>();
    let allowed_origin = lock(&st.allowed_origin).clone();
    let local_server = lock(&st.server_url).clone().or_else(|| lock(&st.proxy_url).clone());
    audio_capture_allowed(page, allowed_origin.as_deref(), local_server.as_deref())
}

/// Sets up microphone access for the main window's WebView (see the module comment). Never fails the app: a
/// WebView that cannot be configured only means the recorder cannot use the microphone.
pub fn install(app: &AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(any(target_os = "linux", windows))]
    {
        let h = app.clone();
        if let Err(e) = window.with_webview(move |webview| platform::install(h, webview)) {
            config::log(app, &format!("microphone setup failed: {e}"));
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (app, window); // macOS: Info.plist + entitlements, wry grants the requests
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use webkit2gtk::glib::prelude::{Cast, ObjectExt};
    use webkit2gtk::glib::translate::ToGlibPtr;
    use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};

    extern "C" {
        // WebKitGTK 2.34+ (wry needs 2.40): a getDisplayMedia request. webkit2gtk-rs 2.0 has no binding for it.
        // (The C API names it without "_request", like webkit_user_media_permission_is_for_audio_device.)
        fn webkit_user_media_permission_is_for_display_device(request: *mut webkit2gtk::ffi::WebKitUserMediaPermissionRequest) -> i32;
    }

    pub fn install(app: AppHandle, webview: tauri::webview::PlatformWebview) {
        let wv = webview.inner();
        // The default is on in current WebKitGTK, off in older builds: always set it.
        if let Some(settings) = WebViewExt::settings(&wv) {
            settings.set_enable_media_stream(true);
        }
        wv.connect_permission_request(move |wv, request| {
            let page = wv.uri().map(|u| u.to_string()).unwrap_or_default();
            if let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() {
                let display = unsafe { webkit_user_media_permission_is_for_display_device(media.to_glib_none().0) != 0 };
                let audio_only = media.is_for_audio_device() && !media.is_for_video_device() && !display;
                let ok = audio_only && allowed(&app, &page);
                config::log(
                    &app,
                    &format!("microphone request from {page} (audio only: {audio_only}): {}", if ok { "allowed" } else { "denied" }),
                );
                if ok {
                    request.allow();
                } else {
                    request.deny();
                }
                return true;
            }
            // enumerateDevices() with device names, for the same pages.
            if request.is::<webkit2gtk::DeviceInfoPermissionRequest>() {
                if allowed(&app, &page) {
                    request.allow();
                } else {
                    request.deny();
                }
                return true;
            }
            false // anything else: WebKit's default
        });
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };

    pub fn install(app: AppHandle, webview: tauri::webview::PlatformWebview) {
        let core = match unsafe { webview.controller().CoreWebView2() } {
            Ok(core) => core,
            Err(e) => return config::log(&app, &format!("microphone setup: no CoreWebView2 ({e})")),
        };
        let h = app.clone();
        let handler = webview2_com::PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            unsafe { args.PermissionKind(&mut kind)? };
            if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                let mut uri = windows_core::PWSTR::null();
                unsafe { args.Uri(&mut uri)? };
                let page = webview2_com::take_pwstr(uri);
                let ok = allowed(&h, &page);
                config::log(&h, &format!("microphone request from {page}: {}", if ok { "allowed" } else { "denied" }));
                let state = if ok { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY };
                unsafe { args.SetState(state)? };
            } else if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)? };
            }
            Ok(()) // anything else: WebView2's default
        }));
        let mut token = 0i64;
        if let Err(e) = unsafe { core.add_PermissionRequested(&handler, &mut token) } {
            config::log(&app, &format!("microphone setup: PermissionRequested failed ({e})"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: &str = "http://127.0.0.1:5350";

    #[test]
    fn the_local_server_may_record() {
        let allowed = Some("http://127.0.0.1:5350");
        assert!(audio_capture_allowed("http://127.0.0.1:5350/", allowed, Some(LOCAL)));
        assert!(audio_capture_allowed("http://127.0.0.1:5350/?doc=abc#p7", allowed, Some(LOCAL)));
        // Another port on this computer is another origin (e.g. `npm start` on 5180 in some window).
        assert!(!audio_capture_allowed("http://127.0.0.1:5180/", allowed, Some(LOCAL)));
        assert!(!audio_capture_allowed("http://localhost:5350/", allowed, Some(LOCAL)));
    }

    #[test]
    fn the_relay_for_a_plain_http_remote_may_record_like_the_local_server() {
        // The window shows the relay (proxy.rs) instead of http://192.168.0.10:5180: its loopback origin is the one
        // the shell runs now, passed as `local_server`.
        let relay = "http://127.0.0.1:5360";
        assert!(audio_capture_allowed("http://127.0.0.1:5360/", Some(relay), Some(relay)));
        assert!(audio_capture_allowed("http://127.0.0.1:5360/?doc=abc", Some(relay), Some(relay)));
        // Another loopback port (a server the shell does not run), and the relay's page when it is not the allowed one.
        assert!(!audio_capture_allowed("http://127.0.0.1:5361/", Some(relay), Some(relay)));
        assert!(!audio_capture_allowed("http://127.0.0.1:5360/", Some(LOCAL), Some(LOCAL)));
        assert!(!audio_capture_allowed("http://127.0.0.1:5360/", Some(relay), None));
    }

    #[test]
    fn a_remote_server_only_over_https_and_only_the_chosen_one() {
        let chosen = Some("https://study-pc.tail1234.ts.net");
        assert!(audio_capture_allowed("https://study-pc.tail1234.ts.net/", chosen, None));
        // The local server keeps running while a remote one is shown? Its origin is not the allowed one then.
        assert!(!audio_capture_allowed(LOCAL, chosen, Some(LOCAL)));
        assert!(!audio_capture_allowed("https://evil.example/", chosen, None));
        // Plain http on the LAN: never (and no secure context there anyway).
        let lan = Some("http://192.168.0.10:5180");
        assert!(!audio_capture_allowed("http://192.168.0.10:5180/", lan, None));
        assert!(!audio_capture_allowed("http://192.168.0.10:5180/", lan, Some(LOCAL)));
    }

    #[test]
    fn nothing_else_records() {
        assert!(!audio_capture_allowed("tauri://localhost/index.html", Some("tauri://localhost"), Some(LOCAL)));
        assert!(!audio_capture_allowed("http://tauri.localhost/index.html", Some("http://tauri.localhost"), None));
        assert!(!audio_capture_allowed("about:blank", Some("null"), Some(LOCAL)));
        assert!(!audio_capture_allowed("", Some("http://127.0.0.1:5350"), Some(LOCAL)));
        assert!(!audio_capture_allowed("not a url", Some("http://127.0.0.1:5350"), Some(LOCAL)));
        // Before anything was chosen (the chooser is showing).
        assert!(!audio_capture_allowed("http://127.0.0.1:5350/", None, Some(LOCAL)));
        assert!(!audio_capture_allowed("http://127.0.0.1:5350/", None, None));
    }
}
