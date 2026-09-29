//! "다른 컴퓨터에 연결": checking a remote easy-study server before the window goes there (DESIGN §19).
//!
//! The WebView gives no usable error for a server that is down, a name that does not resolve or an HTTPS
//! certificate it does not trust (the window just stays blank), so the shell asks the server's
//! `GET /api/auth/status` itself first and explains what is wrong in the chooser:
//! - plain http only to addresses on this network (private, link-local, loopback, Tailscale's 100.64/10,
//!   IPv6 ULA; `.local` names resolve to those): the access code and the session cookie would otherwise
//!   cross the internet unencrypted;
//! - https only with a certificate this computer trusts (native-tls = the OS's own verifier and trust store,
//!   as the WebView uses): a self-signed certificate cannot be accepted in the app window.

use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::time::Duration;

use tauri::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const IO_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_RESPONSE: usize = 256 * 1024;

pub const URL_EXAMPLE: &str = "http://192.168.0.10:5180";

/// The origin (scheme://host:port/) of what the user typed. No scheme = http.
pub fn parse(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err(format!("연결할 컴퓨터의 주소를 입력하세요 (예: {URL_EXAMPLE})."));
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("http://{input}") };
    let mut url = Url::parse(&with_scheme).map_err(|_| format!("주소 형식이 올바르지 않아요 (예: {URL_EXAMPLE})."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("http:// 또는 https:// 주소만 쓸 수 있어요.".into());
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err(format!("주소에 컴퓨터 이름이나 IP가 없어요 (예: {URL_EXAMPLE})."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("주소에 사용자 이름이나 비밀번호를 넣지 마세요. 접속 코드는 아래 칸에 입력하세요.".into());
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// `<origin>/login?code=<code>`: the server's one-click login (auth.ts loginLink) sets the session cookie and
/// answers 303 to "/", so the code leaves the address bar. `origin` is an origin or a base URL without a path.
pub fn login_url(origin: &str, code: &str) -> Result<String, String> {
    let base = Url::parse(origin).map_err(|e| e.to_string())?;
    let mut login = base.join("/login").map_err(|e| e.to_string())?;
    login.query_pairs_mut().append_pair("code", code);
    Ok(login.to_string())
}

/// Whether `host` (of a URL) is this computer itself: loopback addresses and `localhost`.
pub fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Addresses that stay on this computer or this network (including Tailscale's CGNAT range).
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

pub struct Response {
    pub status: u16,
    pub location: Option<String>,
    pub body: String,
}

trait Stream: Read + Write {}
impl<T: Read + Write> Stream for T {}

/// A small HTTP/1.1 GET (Connection: close) over TCP or TLS, for the probe.
pub fn get(url: &Url) -> Result<Response, String> {
    get_with(url, &[])
}

/// `get` with extra request headers (`Authorization: Bearer <code>` for the shared local server's busy check).
/// Names and values are the shell's own constants: a value with CR/LF would end the header block and is refused.
pub fn get_with(url: &Url, extra: &[(&str, &str)]) -> Result<Response, String> {
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<SocketAddr> = url
        .socket_addrs(|| None)
        .map_err(|_| format!("{host} 주소를 찾을 수 없어요. 컴퓨터 이름이나 IP 주소를 확인하세요."))?;
    if addrs.is_empty() {
        return Err(format!("{host} 주소를 찾을 수 없어요."));
    }
    let https = url.scheme() == "https";
    if !https {
        if let Some(public) = addrs.iter().find(|a| !is_private(a.ip())) {
            let ip = public.ip().to_string();
            let shown = if host.trim_matches(['[', ']']) == ip { host.clone() } else { format!("{host}({ip})") };
            return Err(format!(
                "{shown}은(는) 이 네트워크 밖의 주소예요. 암호화되지 않은 http:// 로는 같은 네트워크(집·학교 Wi-Fi, Tailscale)의 \
                 컴퓨터에만 연결할 수 있어요. 인터넷을 거쳐 연결하려면 https:// 주소(예: tailscale serve)를 쓰세요."
            ));
        }
    }
    let mut failures: Vec<(IpAddr, Option<i32>)> = Vec::new();
    let mut connected = None;
    for a in &addrs {
        match TcpStream::connect_timeout(a, CONNECT_TIMEOUT) {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(e) => failures.push((a.ip(), e.raw_os_error())),
        }
    }
    let tcp = connected.ok_or_else(|| connect_failure_message(&host, port, &failures, cfg!(target_os = "macos")))?;
    let _ = tcp.set_read_timeout(Some(IO_TIMEOUT));
    let _ = tcp.set_write_timeout(Some(IO_TIMEOUT));
    let mut stream: Box<dyn Stream> = if https {
        let connector = native_tls::TlsConnector::new().map_err(|e| format!("HTTPS를 준비하지 못했어요: {e}"))?;
        Box::new(connector.connect(&host, tcp).map_err(|e| tls_failure_message(&host, port, &e.to_string()))?)
    } else {
        Box::new(tcp)
    };
    let authority = match url.port() {
        Some(p) => format!("{}:{p}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    };
    let path = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    };
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\nAccept: application/json\r\nUser-Agent: easy-study-desktop\r\nConnection: close\r\n");
    for (name, value) in extra {
        if name.contains(['\r', '\n', ':']) || value.contains(['\r', '\n']) {
            return Err(format!("요청 헤더 {name}의 값이 올바르지 않아요."));
        }
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).map_err(|e| format!("{host}:{port}에 요청을 보내지 못했어요: {e}"))?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > MAX_RESPONSE {
                    break;
                }
            }
            // A TLS peer that closes without close_notify, or a read timeout after the answer: keep what came.
            Err(_) if !raw.is_empty() => break,
            Err(e) => return Err(format!("{host}:{port}에서 응답을 받지 못했어요: {e}")),
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("{host}:{port}은(는) HTTP 서버가 아닌 것 같아요."))?;
    let location = lines.find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("location").then(|| v.trim().to_string())
    });
    Ok(Response { status, location, body: body.to_string() })
}

/// macOS (errno): no route to the host / the network. Also what a connection gets while macOS 15+ keeps the
/// app off the local network (Local Network privacy: asked once, per app; loopback is exempt).
const MACOS_UNREACHABLE: [i32; 2] = [65, 51];

/// Why no address of `host` accepted the connection (`failures`: each address with its OS error code).
fn connect_failure_message(host: &str, port: u16, failures: &[(IpAddr, Option<i32>)], macos: bool) -> String {
    let mut msg = format!(
        "{host}:{port}에 연결할 수 없어요. 그 컴퓨터에서 easy-study가 원격 모드로 실행 중인지 \
         (npm run start:remote), 같은 네트워크에 있는지, 방화벽이 막고 있지 않은지 확인하세요."
    );
    let local_network = failures
        .iter()
        .any(|(ip, code)| is_private(*ip) && !ip.is_loopback() && code.is_some_and(|c| MACOS_UNREACHABLE.contains(&c)));
    if macos && local_network {
        msg.push_str(
            " 이 Mac이 easy-study의 로컬 네트워크 접근을 막고 있을 수도 있어요: 시스템 설정 › 개인정보 보호 및 보안 › \
             로컬 네트워크에서 easy-study를 켠 뒤 다시 연결하세요.",
        );
    }
    msg
}

/// Error texts (lower case) of a TLS handshake with a server that does not speak TLS on that port — a plain
/// http easy-study server, say: Security.framework (macOS), OpenSSL (Linux), SChannel (Windows).
const NOT_TLS: &[&str] = &[
    "record overflow",
    "-9847",
    "wrong version number",
    "packet length too long",
    "http request",
    "unknown protocol",
    "record layer failure",
    "badly formatted",
    "-2146893018",
    "0x80090326",
];

/// Error texts (lower case) of a certificate this computer does not accept.
const CERTIFICATE: &[&str] = &[
    "certificate",
    "cert chain",
    "trust",
    "self signed",
    "self-signed",
    "issuer",
    "principal name",
    "hostname mismatch",
    "not valid for",
    "expired",
    "-9807",
    "-9813",
    "-2146893019",
    "-2146893022",
    "-2146762487",
];

/// Why the TLS handshake with `host` failed. native-tls passes on the platform's own error text, so it is
/// matched as text: a server that answers in plain http is not a certificate problem.
fn tls_failure_message(host: &str, port: u16, err: &str) -> String {
    let lower = err.to_lowercase();
    if NOT_TLS.iter().any(|m| lower.contains(m)) {
        format!(
            "{host}:{port}은(는) HTTPS로 응답하지 않아요 ({err}). 인증서 없이 켠 easy-study 서버(npm run start:remote)는 \
             http로 열려요: 같은 네트워크라면 주소를 http:// 로 바꿔 보세요."
        )
    } else if CERTIFICATE.iter().any(|m| lower.contains(m)) {
        format!(
            "{host}의 HTTPS 인증서를 이 컴퓨터가 신뢰하지 않아요 ({err}). 앱 창은 자체 서명 인증서를 받아들일 수 없어요: \
             tailscale serve / tailscale cert처럼 신뢰받는 인증서를 쓰거나, mkcert의 루트 인증서를 이 컴퓨터에 설치하세요. \
             같은 네트워크라면 http:// 주소도 쓸 수 있어요."
        )
    } else {
        format!(
            "{host}:{port}와(과) HTTPS 연결을 맺지 못했어요 ({err}). 주소와 포트가 맞는지, 그 서버가 https로 열려 있는지 \
             확인하세요. 같은 네트워크라면 http:// 주소도 쓸 수 있어요."
        )
    }
}

/// What `GET /api/auth/status` said.
pub struct Status {
    pub auth_required: bool,
}

/// Checks that `origin` is a reachable easy-study server the app window can show.
pub fn probe(origin: &Url) -> Result<Status, String> {
    let url = origin.join("/api/auth/status").map_err(|e| e.to_string())?;
    let res = get(&url)?;
    if (300..400).contains(&res.status) {
        let to = res.location.unwrap_or_default();
        return Err(format!("{origin} 은(는) 다른 주소({to})로 넘어가요. 그 주소로 연결해 보세요."));
    }
    // The JSON object (also when the answer came chunked: take the outermost braces).
    let json = match (res.body.find('{'), res.body.rfind('}')) {
        (Some(a), Some(b)) if a < b => serde_json::from_str::<serde_json::Value>(&res.body[a..=b]).ok(),
        _ => None,
    };
    match json.as_ref().and_then(|v| v.get("authRequired")).and_then(|v| v.as_bool()) {
        Some(auth_required) if res.status == 200 => Ok(Status { auth_required }),
        _ => Err(format!(
            "{origin} 에서 easy-study 서버를 찾지 못했어요 (HTTP {}). 주소와 포트 번호를 확인하세요.",
            res.status
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_origins() {
        assert_eq!(parse("192.168.0.10:5180").unwrap().as_str(), "http://192.168.0.10:5180/");
        assert_eq!(parse(" https://mac.tail1234.ts.net/x?y#z ").unwrap().as_str(), "https://mac.tail1234.ts.net/");
        assert!(parse("ftp://host").is_err());
        assert!(parse("http://user:pw@host").is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn login_links_carry_the_code_in_the_query() {
        assert_eq!(login_url("http://127.0.0.1:5378", "k7qm2-x9fda-3hz8w-p0rtc").unwrap(), "http://127.0.0.1:5378/login?code=k7qm2-x9fda-3hz8w-p0rtc");
        assert_eq!(login_url("http://192.168.0.10:5180/", "a b&c").unwrap(), "http://192.168.0.10:5180/login?code=a+b%26c");
        assert!(login_url("not a url", "x").is_err());
        for host in ["127.0.0.1", "localhost", "LOCALHOST", "[::1]", "::1", "127.5.5.5"] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in ["192.168.0.10", "my-mac.local", "[fd7a:115c:a1e0::1]", "localhost.example", ""] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }

    #[test]
    fn tls_failures_are_told_apart() {
        let not_https = [
            "record overflow",                                                                                    // macOS
            "error:0A00010B:SSL routines:ssl3_get_record:wrong version number:../ssl/record/ssl3_record.c:354:", // OpenSSL
            "The message received was unexpected or badly formatted. (os error -2146893018)",                    // Windows
        ];
        for err in not_https {
            let msg = tls_failure_message("192.168.0.10", 5180, err);
            assert!(msg.contains("HTTPS로 응답하지 않아요") && msg.contains("http://"), "{err}: {msg}");
            assert!(!msg.contains("인증서를 이 컴퓨터가 신뢰하지"), "{err}");
        }
        let untrusted = [
            "invalid certificate chain",
            "error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed:../ssl/statem/statem_clnt.c:1889:: self-signed certificate",
            "The certificate chain was issued by an authority that is not trusted. (os error -2146893019)",
            "The target principal name is incorrect. (os error -2146893022)",
        ];
        for err in untrusted {
            assert!(tls_failure_message("mac.local", 443, err).contains("인증서를 이 컴퓨터가 신뢰하지 않아요"), "{err}");
        }
        let other = tls_failure_message("host", 8443, "connection reset by peer");
        assert!(other.contains("HTTPS 연결을 맺지 못했어요"), "{other}");
    }

    #[test]
    fn unreachable_lan_hosts_mention_local_network_privacy_on_macos() {
        let lan: IpAddr = "192.168.0.10".parse().unwrap();
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let hint = "로컬 네트워크에서 easy-study를 켠 뒤";
        assert!(connect_failure_message("192.168.0.10", 5180, &[(lan, Some(65))], true).contains(hint));
        assert!(connect_failure_message("mac.local", 5180, &[(lan, Some(51))], true).contains(hint));
        assert!(!connect_failure_message("192.168.0.10", 5180, &[(lan, Some(65))], false).contains(hint));
        assert!(!connect_failure_message("192.168.0.10", 5180, &[(lan, Some(61))], true).contains(hint)); // refused
        assert!(!connect_failure_message("127.0.0.1", 5180, &[(loopback, Some(65))], true).contains(hint));
        assert!(connect_failure_message("192.168.0.10", 5180, &[], true).contains("192.168.0.10:5180에 연결할 수 없어요"));
    }

    #[test]
    fn private_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.2", "169.254.1.1", "100.100.1.1", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:192.168.1.1"] {
            assert!(is_private(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:4860:4860::8888"] {
            assert!(!is_private(ip.parse().unwrap()), "{ip}");
        }
    }
}
