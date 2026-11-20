// 手元（127.0.0.1）のサービスへの小さなHTTPクライアントと、ポートの使用の確認。
// 起動の確認（readyUrl）、正のLLMのハートビート、backendの管理用APIの呼び出しに使う。
// WebViewのfetchで呼ぶとCORSの制約を受けるため、Rustから呼ぶ。HTTP/1.1・Connection: closeだけを扱う。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

struct Target {
    host: String,
    port: u16,
    path: String,
}

fn parse_url(url: &str) -> Result<Target, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("only http:// is supported: {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| format!("bad port: {url}"))?),
        None => (authority, 80),
    };
    if host.is_empty() {
        return Err(format!("no host: {url}"));
    }
    Ok(Target {
        host: host.to_string(),
        port,
        path: path.to_string(),
    })
}

fn resolve(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| format!("cannot resolve {host}"))
}

/// 要求を送り、応答の状態と本文を返す。つながらない・時間切れはErr。
pub fn request(
    method: &str,
    url: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<HttpResponse, String> {
    let target = parse_url(url)?;
    let addr = resolve(&target.host, target.port)?;
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    let mut head = format!(
        "{method} {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nAccept: application/json\r\n",
        target.path, target.host, target.port
    );
    if let Some(b) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    } else if method != "GET" {
        head.push_str("Content-Length: 0\r\n");
    }
    head.push_str("\r\n");
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(head.as_bytes())
        .map_err(|e| e.to_string())?;
    if let Some(b) = body {
        stream.write_all(b.as_bytes()).map_err(|e| e.to_string())?;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("timeout".into());
        }
        stream
            .set_read_timeout(Some(left))
            .map_err(|e| e.to_string())?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(res) = parse_response(&buf, false) {
                    return Ok(res);
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    parse_response(&buf, true).ok_or_else(|| "malformed response".into())
}

/// 受け取った分から応答を組み立てる。まだ足りなければNone（eofなら、あるだけで組み立てる）。
fn parse_response(buf: &[u8], eof: bool) -> Option<HttpResponse> {
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..split]);
    let rest = &buf[split + 4..];
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let mut length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "content-length" {
            length = value.parse().ok();
        } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    let body = if chunked {
        decode_chunked(rest).or(if eof { Some(rest.to_vec()) } else { None })?
    } else if let Some(n) = length {
        if rest.len() < n {
            if eof {
                rest.to_vec()
            } else {
                return None;
            }
        } else {
            rest[..n].to_vec()
        }
    } else if status == 204 || status == 304 {
        Vec::new()
    } else if eof {
        rest.to_vec()
    } else {
        return None;
    };
    Some(HttpResponse {
        status,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// chunkedの本文。終わりの0のチャンクまでそろっていなければNone。
fn decode_chunked(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = data.windows(2).position(|w| w == b"\r\n")?;
        let size_text = String::from_utf8_lossy(&data[..line_end]);
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if data.len() < size + 2 {
            return None;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

/// GETして200番台ならtrue。
pub fn probe(url: &str, timeout: Duration) -> bool {
    matches!(request("GET", url, None, timeout), Ok(r) if (200..300).contains(&r.status))
}

/// 127.0.0.1のポートが使われているか。つながる（だれかが待ち受けている）か、待ち受けられなければ使用中。
pub fn port_in_use(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
        return true;
    }
    TcpListener::bind(addr).is_err()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn parses_urls() {
        let t = parse_url("http://127.0.0.1:8788/admin/status").unwrap();
        assert_eq!(
            (t.host.as_str(), t.port, t.path.as_str()),
            ("127.0.0.1", 8788, "/admin/status")
        );
        let t = parse_url("http://localhost").unwrap();
        assert_eq!((t.port, t.path.as_str()), (80, "/"));
        assert!(parse_url("https://example.com").is_err());
    }

    #[test]
    fn parses_content_length_and_chunked() {
        let r = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", false).unwrap();
        assert_eq!((r.status, r.body.as_str()), (200, "ok"));
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nok", false).is_none());
        let r = parse_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n1\r\nc\r\n0\r\n\r\n",
            false,
        )
        .unwrap();
        assert_eq!(r.body, "abc");
        let r = parse_response(b"HTTP/1.1 204 No Content\r\n\r\n", false).unwrap();
        assert_eq!((r.status, r.body.as_str()), (204, ""));
    }

    /// 1回だけ決まった応答を返すサーバー。
    fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            s.write_all(response.as_bytes()).unwrap();
        });
        port
    }

    #[test]
    fn requests_and_probes() {
        let port = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}");
        let r = request(
            "GET",
            &format!("http://127.0.0.1:{port}/x"),
            None,
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(r.body, "{\"ok\":true}");
        let port = serve_once("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
        assert!(!probe(
            &format!("http://127.0.0.1:{port}/health"),
            Duration::from_secs(2)
        ));
    }

    #[test]
    fn detects_port_in_use() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_in_use(port));
        drop(listener);
        assert!(!port_in_use(port));
    }
}
