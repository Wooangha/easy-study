//! English (i18n.rs): the same fields as the Korean reference (i18n/ko.rs), with its meaning and tone. The macOS menu
//! items the system names use Apple's names ("Hide Others", "Select All"); the rest is sentence case.

use super::*;

pub static TEXTS: Texts = Texts {
    common: Common {
        ok: "OK",
        cancel: "Cancel",
        close: "Close",
        installing_update: "Installing an update. The app restarts when it's done.",
        unknown_theme: |theme| format!("Unknown theme: {theme}"),
        no_resource_dir: |e| format!("Couldn't find the app's resource folder: {e}"),
        no_node: |path| format!("Couldn't find the Node.js that comes with the app: {path}. Try reinstalling the app."),
        exit_code: |code| format!("exit code {code}"),
        exit_signal: |sig| format!("signal {sig}"),
        exit_unknown: "exit status unknown",
    },
    menu: Menu {
        choose: "Change connection…",
        reload: "Reload",
        open_browser: "Open in browser",
        open_library: "Open library folder",
        settings: "Settings…",
        check_update: "Check for updates…",
        install_update: |v| format!("Install update ({v})…"),
        quit_app: |name| format!("Quit {name}"),
        quit: "Quit",
        about: |name| format!("About {name}"),
        services: "Services",
        hide: |name| format!("Hide {name}"),
        hide_others: "Hide Others",
        show_all: "Show All",
        edit: "Edit",
        undo: "Undo",
        redo: "Redo",
        cut: "Cut",
        copy: "Copy",
        paste: "Paste",
        select_all: "Select All",
        connection: "Connection",
        window: "Window",
        minimize: "Minimize",
        zoom: "Zoom",
        fullscreen: "Toggle Full Screen",
        close_window: "Close Window",
    },
    leave: Leave {
        choose_recording: "A lecture is being recorded. Changing the connection stops the recording (what's recorded so far is saved and finishes uploading when you connect to the same server again).",
        choose: "Change",
        reload_recording: "A lecture is being recorded. Reloading stops the recording (what's recorded so far is saved and finishes uploading when you open the page again).",
        reload: "Reload",
    },
    library: Library {
        pick_title: "Choose library folder",
        unreadable: |e| format!("Can't read this folder ({e}). Use it anyway?"),
        not_a_library: |name| {
            format!("The folder ‘{name}’ isn't empty and doesn't look like an easy-study library. Each lecture gets its own folder inside it. Use this folder anyway?")
        },
        from_env: |var| format!("The {var} environment variable sets the library folder."),
        not_a_folder: |path| format!("Not a folder: {path}"),
        not_writable: |path, e| format!("Can't write to this folder: {path} ({e})"),
        changed_stopping: "Library folder changed. Stopping the server that was running — press ‘Connect’ to start it with the new folder.",
        changed: "Library folder changed.",
    },
    launch: Launch {
        crashed: "The app closed right after it connected last time, so the connection screen comes first this time. Choose where to connect.",
        connecting: |saved| format!("Connecting to {saved}…"),
        saved_failed: |e| format!("Couldn't connect to the saved server. {e}"),
    },
    server: Server {
        starting: "Starting the easy-study server on this computer…",
        no_entry: |path| format!("Couldn't find the easy-study server that comes with the app: {path}. Try reinstalling the app."),
        no_library: |path, e| format!("Can't create the library folder: {path} ({e})"),
        spawn_failed: |e, node| format!("Couldn't start the server: {e} ({node})"),
        not_ready: |secs| format!("The easy-study server on this computer wasn't ready within {secs} seconds, so it was stopped."),
        exited: |how| format!("The easy-study server on this computer stopped unexpectedly ({how}). Press ‘Connect’ to start it again."),
        not_started: |how| format!("Couldn't start the easy-study server on this computer ({how})."),
    },
    relay: Relay {
        missing: "The app's connection relay is missing (proxy.js). Please reinstall the app.",
        no_port: "Couldn't find a port for the connection relay (proxy).",
        spawn_failed: |e| format!("Couldn't start the connection relay (proxy): {e}"),
        not_started: |how, last| format!("The connection relay (proxy) didn't start ({how}). {last}"),
        not_ready: |secs| format!("The connection relay (proxy) wasn't ready within {secs} seconds."),
        exited: |how| format!("The connection relay (proxy) stopped unexpectedly ({how}). Please connect again."),
    },
    remote: Remote {
        enter_address: |example| format!("Enter the address of the computer to connect to (e.g. {example})."),
        bad_address: |example| format!("That address isn't valid (e.g. {example})."),
        http_only: "Only http:// or https:// addresses work.",
        no_host: |example| format!("The address has no computer name or IP (e.g. {example})."),
        no_credentials: "Don't put a user name or password in the address. Enter the access code in the field below.",
        unresolved: |host| format!("Can't find the address {host}. Check the computer name or IP address."),
        unresolved_short: |host| format!("Can't find the address {host}."),
        public_http: |shown| {
            format!(
                "{shown} is outside this network. Unencrypted http:// only connects to computers on the same network (home or \
                 school Wi-Fi, Tailscale). To connect over the internet, use an https:// address (e.g. tailscale serve)."
            )
        },
        no_tls: |e| format!("Couldn't set up HTTPS: {e}"),
        bad_header: |name| format!("The value of the request header {name} isn't valid."),
        send_failed: |host, port, e| format!("Couldn't send the request to {host}:{port}: {e}"),
        receive_failed: |host, port, e| format!("No answer from {host}:{port}: {e}"),
        not_http: |host, port| format!("{host}:{port} doesn't seem to be an HTTP server."),
        connect_failed: |host, port| {
            format!(
                "Can't connect to {host}:{port}. Check that easy-study runs in remote mode on that computer \
                 (npm run start:remote), that it's on the same network, and that a firewall isn't blocking it."
            )
        },
        local_network: " This Mac may be keeping easy-study off the local network: turn on easy-study in System Settings › \
                        Privacy & Security › Local Network, then connect again.",
        not_https: |host, port, err| {
            format!(
                "{host}:{port} doesn't answer over HTTPS ({err}). An easy-study server started without a certificate \
                 (npm run start:remote) opens over http: on the same network, try changing the address to http://."
            )
        },
        untrusted: |host, err| {
            format!(
                "This computer doesn't trust the HTTPS certificate of {host} ({err}). The app window can't accept a \
                 self-signed certificate: use a trusted certificate such as tailscale serve / tailscale cert, or install \
                 mkcert's root certificate on this computer. On the same network, an http:// address works too."
            )
        },
        tls_failed: |host, port, err| {
            format!(
                "Couldn't make an HTTPS connection to {host}:{port} ({err}). Check the address and port, and that the \
                 server is open over https. On the same network, an http:// address works too."
            )
        },
        redirected: |origin, to| format!("{origin} redirects to another address ({to}). Try connecting to that address."),
        not_easy_study: |origin, status| format!("No easy-study server found at {origin} (HTTP {status}). Check the address and port number."),
    },
    busy: Busy {
        block_recording: "A lecture is being recorded. Try installing again after the recording ends.",
        block_unsent: "Recorded audio is still being sent to the server. Try installing again once it's all sent.",
        block_recording_share: "A lecture is being recorded. Try again after the recording ends.",
        block_unsent_share: "Recorded audio is still being sent to the server. Try again once it's all sent.",
        warn_install: "Restarting stops this work. Install and restart anyway?",
        warn_share: "Restarting stops this work. Restart the server anyway?",
        answering: "Writing an answer.",
        uploading: "Uploading files.",
        page_unknown: "Couldn't check whether this page is recording or doing other work.",
        recording_named: |doc, title| format!("The recording ‘{title}’ in ‘{doc}’ isn't finished yet (you can continue it after the restart)."),
        recording: "A recording isn't finished yet (you can continue it after the restart).",
        transcribing: |n| if n == 1 { "Transcribing 1 recording.".into() } else { format!("Transcribing {n} recordings.") },
        digesting: "Making a lecture digest.",
        answers_elsewhere: |n| if n == 1 { "Writing 1 answer in another window.".into() } else { format!("Writing {n} answers in other windows.") },
        answers: |n| if n == 1 { "Writing 1 answer.".into() } else { format!("Writing {n} answers.") },
        model_download: "Downloading a speech recognition model.",
        server_unknown: "Couldn't check whether the server on this computer is busy.",
    },
    page: Page {
        confirm_reveal: "Show the access code on this screen?\n\nAnyone who knows the code can log in to easy-study on this computer from the same network.",
        reveal: "Show",
        confirm_choose: "Go back to the connection screen?\n\nThe page you're viewing asked for this.",
        choose: "Go back",
        confirm_forget: "Show the connection screen first from the next launch?\n\nThe page you're viewing asked for this.",
        forget: "Show it first",
        confirm_cancel_download: "Cancel downloading the new version?\n\nThe page you're viewing asked for this.",
        cancel_download: "Cancel download",
        keep_downloading: "Keep downloading",
    },
    share: Share {
        starting: "The server on this computer is starting. Try again when it's ready.",
        restarting: "Restarting the server on this computer to apply the setting…",
        confirm_on: "Allow access from other devices?\n\nDevices on the same network can use easy-study on this computer with the \
                     access code, and the server on this computer restarts.",
        allow: "Allow",
        restart: "Restart",
    },
    update: Update {
        network: "Couldn't connect to the update server. Check your internet connection.",
        no_file: "There's no update file for this computer yet.",
        signature: "The downloaded file's signature didn't match, so it wasn't installed.",
        wrong_file: "The downloaded file isn't for this computer, so it wasn't installed.",
        mac_permission: "No permission to change the app folder. Download the new version and install it yourself.",
        appimage_permission: "No permission to change this AppImage file. Download the new AppImage.",
        installer: "Couldn't start the installer. Get the new version from the download page and install it.",
        other: "Couldn't update. Try again later, or get the new version from the download page.",
        reason_move_app: "Move the app to the ‘Applications’ folder and open it again to update it.",
        reason_extracted: "An extracted AppImage can't update itself. Download the new AppImage.",
        reason_deb: "Installed from a deb package: get the new package and install it.",
        reason_rpm: "Installed from an rpm package: get the new package and install it.",
        reason_arch: "Installed from the Arch package: reinstall it with the release's PKGBUILD (makepkg -si).",
        reason_installer: "This kind of install can't update itself. Get the new installer.",
        reason_dev: "Development builds don't update themselves.",
        installing: |version| format!("Installing easy-study {version}… The app restarts when it's done."),
        did_not_take: |current| format!("The update didn't finish (this is still {current}). Install it yourself from the download page."),
        failed_prefixes: &["The update ", "Couldn't update"],
        failed: |text| format!("Couldn't update: {text}"),
        could_not_check: |text| format!("Couldn't check for updates: {text}"),
        latest: |current| format!("You're on the latest version (easy-study {current})."),
        still_checking: "Still checking. Check again in a moment.",
        downloading: |version| format!("Downloading easy-study {version}."),
        preparing: "Preparing the update.",
        available: |version, current| format!("easy-study {version} is available (you have {current})."),
        install_now: "Install it now and restart the app?",
        confirm_install: |version| format!("Install easy-study {version} and restart the app?"),
        install_restart: "Install and restart",
        later: "Later",
        open_download: "Open download page",
        kept_download: |msg| format!("{msg}\n\nThe new version is downloaded. Install it after the recording ends."),
    },
};
