//! "다른 기기에서 접속 허용" (DESIGN §16, §19): the switch in the chooser's "⚙ 앱 설정" and in the web client's
//! ⚙ 설정 › 데스크톱 앱. On, the local server runs shared — every interface, the login on with the generated access
//! code in the library's .auth.json (server.rs: EASY_STUDY_DESKTOP_SHARE=1); off (the default), 127.0.0.1 only
//! without a login. Changing it while the server runs restarts the server behind the same busy check as an
//! update (bridge::busy_gate_for: never while a recording could lose audio, the user decides about the rest), and
//! the setting is written only once that check passed. "접속 코드 새로 만들기" restarts the same way with
//! EASY_STUDY_DESKTOP_RESET_CODE=1: a new code, every device logged out. The addresses and the code are shown by
//! the chooser (get_state) and pushed into this computer's own page (bridge::push_state), never elsewhere.
//! A page's share/on goes through a native dialog first (bridge::confirm, which no page can draw or click): an XSS
//! in the web client must not open this computer to the network by itself. A change made in the chooser while the
//! server runs leaves the chooser showing when the server is back (AppState::stay_on_chooser): the user came for
//! the addresses and the code, not for the page.

use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

use tauri::{AppHandle, Manager};

use crate::bridge::{self, Gate, Restart};
use crate::config::{self, lock};
use crate::{i18n, server, update, AppState};

/// Who asked for the change.
pub enum From {
    Chooser,
    /// This computer's own page (its origin), through a share/* action.
    Page { origin: String },
}

/// What to change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    /// The switch.
    Share(bool),
    /// A new access code, every device logged out (the next start of the local server).
    ResetCode,
}

/// Clears an AtomicBool when dropped (as update.rs's): every return path of the flow gives it back.
struct Flag<'a>(&'a AtomicBool);

impl<'a> Flag<'a> {
    fn take(flag: &'a AtomicBool) -> Option<Flag<'a>> {
        (!flag.swap(true, SeqCst)).then_some(Flag(flag))
    }
}

impl Drop for Flag<'_> {
    fn drop(&mut self) {
        self.0.store(false, SeqCst);
    }
}

fn describe(change: Change) -> &'static str {
    match change {
        Change::Share(true) => "sharing on",
        Change::Share(false) => "sharing off",
        Change::ResetCode => "new access code",
    }
}

/// Applies `change` — at once when the local server does not run, else after the busy check and with a restart
/// of the server. Blocks (dialogs, the busy check, the stop): worker threads only. One change at a time.
pub fn request(app: &AppHandle, change: Change, from: From) {
    let st = app.state::<AppState>();
    let m = i18n::msg();
    let Some(_flow) = Flag::take(&st.share_flow) else {
        return bridge::log_limited(app, "share-busy", "sharing: a change is already on its way");
    };
    let page = match &from {
        From::Page { origin } => Some(origin.clone()),
        From::Chooser => None,
    };
    if update::replacing(app) {
        return bridge::tell(app, m.common.installing_update);
    }
    if let Change::Share(on) = change {
        if config::load(app).share == on {
            return bridge::push_state(app); // nothing to change (like a theme that is already set)
        }
    }
    // Between the spawn and the ready line the server has its mode already: a change now would only rewrite the
    // setting and leave the two apart (and the chooser would say the server is not running).
    if st.starting.load(SeqCst) {
        return bridge::tell(app, m.share.starting);
    }
    // Opening the server to the network at a page's request: the user says so in a native dialog no page can draw (the
    // page's own session must not be enough), at most as often as the page may ask (bridge::PageDialogs).
    if let (Some(origin), Change::Share(true)) = (&page, change) {
        if !bridge::page_may_ask(app, origin, true) {
            bridge::log_limited(app, "page-share", &format!("share/on from {origin} ignored (asked too recently)"));
            return bridge::push_state(app);
        }
        let ok = bridge::confirm(app, m.share.confirm_on, m.share.allow, m.common.cancel);
        bridge::page_asked(app, origin, true, ok);
        if !ok {
            return bridge::push_state(app);
        }
    }
    if lock(&st.server_url).is_none() {
        apply(app, change);
        config::log(app, &format!("{}: applies at the next local start", describe(change)));
        return bridge::push_state(app);
    }

    // The server runs: nothing that could lose audio is interrupted, and the user knows what else stops.
    match bridge::busy_gate_for(app, page.is_some(), Restart::Share) {
        Gate::Block(msg) => {
            bridge::tell(app, &msg);
            if let Some(origin) = &page {
                bridge::page_asked(app, origin, true, false);
            }
            return;
        }
        Gate::Warn(msg) => {
            let ok = bridge::confirm(app, &msg, m.share.restart, m.common.cancel);
            if let Some(origin) = &page {
                bridge::page_asked(app, origin, true, ok);
            }
            if !ok {
                return;
            }
        }
        Gate::Go => {}
    }
    apply(app, change);
    config::log(app, &format!("{}: restarting the server", describe(change)));
    bridge::allow_leave(app);
    *lock(&st.busy) = Some(m.share.restarting.into());
    crate::show_chooser(app);
    server::stop(app);
    // start() sets its own busy line and shows the page again when the server is ready (logged in when shared) —
    // unless the change was made in the chooser, which then stays with the addresses and the code (after stop():
    // that clears the flag too).
    st.stay_on_chooser.store(matches!(from, From::Chooser), SeqCst);
    if let Err(e) = server::start(app) {
        st.start_ended();
        *lock(&st.error) = Some(e);
    }
}

fn apply(app: &AppHandle, change: Change) {
    match change {
        Change::Share(on) => {
            config::update(app, |c| c.share = on);
        }
        Change::ResetCode => app.state::<AppState>().reset_code_pending.store(true, SeqCst),
    }
}
