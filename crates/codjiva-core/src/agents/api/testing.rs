//! A tiny HTTP server for tests of the providers. It answers each request with
//! the next canned response and records what it was sent, so a test can check
//! both sides of the exchange without any network access.

use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct Canned {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

impl Canned {
    /// A successful streamed response whose body is the given server-sent
    /// events.
    pub fn sse(events: &[Value]) -> Canned {
        let body: String = events
            .iter()
            .map(|e| {
                format!(
                    "event: {}\ndata: {}\n\n",
                    e["type"].as_str().unwrap_or("message"),
                    e
                )
            })
            .collect();
        Canned {
            status: 200,
            headers: vec![("content-type", "text/event-stream".into())],
            body,
        }
    }

    /// A successful streamed response in the style that ends with a literal
    /// `[DONE]` event.
    pub fn sse_with_done(chunks: &[Value]) -> Canned {
        let mut body: String =
            chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
        body.push_str("data: [DONE]\n\n");
        Canned {
            status: 200,
            headers: vec![("content-type", "text/event-stream".into())],
            body,
        }
    }

    pub fn error(status: u16, body: Value) -> Canned {
        Canned {
            status,
            headers: vec![("content-type", "application/json".into())],
            body: body.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Recorded {
    pub path: String,
    /// Header names are lower-cased.
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

pub struct MockServer {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
}

impl MockServer {
    /// Starts a server that answers with `responses` in order. A request after
    /// the last response gets a 500, which makes a test that sends too many
    /// requests fail visibly.
    pub async fn start(responses: Vec<Canned>) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let queue = Arc::new(Mutex::new(VecDeque::from(responses)));
        let recorded = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (recorded, queue) =
                    (Arc::clone(&recorded), Arc::clone(&queue));
                tokio::spawn(async move {
                    let mut data = Vec::new();
                    let mut chunk = [0u8; 8192];
                    // Read the head, then exactly as many body bytes as it
                    // announces.
                    let (head_end, length) = loop {
                        let Ok(n) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        data.extend_from_slice(&chunk[..n]);
                        if let Some(at) =
                            data.windows(4).position(|w| w == b"\r\n\r\n")
                        {
                            let head = String::from_utf8_lossy(&data[..at])
                                .to_lowercase();
                            let length = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (at + 4, length);
                        }
                    };
                    while data.len() < head_end + length {
                        let Ok(n) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if n == 0 {
                            break;
                        }
                        data.extend_from_slice(&chunk[..n]);
                    }
                    let head =
                        String::from_utf8_lossy(&data[..head_end]).into_owned();
                    let mut lines = head.lines();
                    let path = lines
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("")
                        .to_string();
                    let headers = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(n, v)| {
                            (n.trim().to_lowercase(), v.trim().to_string())
                        })
                        .collect();
                    let body = serde_json::from_slice(&data[head_end..])
                        .unwrap_or(Value::Null);
                    recorded.lock().unwrap().push(Recorded {
                        path,
                        headers,
                        body,
                    });
                    let canned =
                        queue.lock().unwrap().pop_front().unwrap_or(Canned {
                            status: 500,
                            headers: vec![],
                            body: "no canned response left".into(),
                        });
                    let mut response = format!(
                        "HTTP/1.1 {} X\r\ncontent-length: {}\r\nconnection: \
                         close\r\n",
                        canned.status,
                        canned.body.len()
                    );
                    for (name, value) in &canned.headers {
                        response.push_str(&format!("{name}: {value}\r\n"));
                    }
                    response.push_str("\r\n");
                    response.push_str(&canned.body);
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        MockServer { url, requests }
    }

    pub fn recorded(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}
