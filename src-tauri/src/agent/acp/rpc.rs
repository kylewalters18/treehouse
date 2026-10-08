//! Minimal JSON-RPC 2.0 peer over newline-delimited JSON, which is how ACP
//! frames messages on an agent's stdio. Generic over the byte streams so
//! tests can drive it with an in-memory duplex instead of a process.
//!
//! Both sides send requests in ACP: we call `initialize` / `session/*`, the
//! agent calls `session/request_permission` (and `fs/*`, `terminal/*`, which
//! we don't advertise). Outgoing requests resolve through `pending`;
//! everything the agent initiates comes out of the `Incoming` receiver.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

/// JSON-RPC "method not found" — the answer to any agent→client request we
/// don't implement (`fs/*`, `terminal/*`, extensions).
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
/// ACP's "authentication required" error code.
pub const AUTH_REQUIRED: i64 = -32000;

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    /// The error's `data`, when it's a string (agents often put the
    /// parser's complaint there).
    pub detail: Option<String>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)?;
        match &self.detail {
            Some(d) => write!(f, ": {d}"),
            None => Ok(()),
        }
    }
}

/// Something the agent sent us that isn't a response.
#[derive(Debug)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>;

pub struct RpcConn {
    out: mpsc::UnboundedSender<String>,
    pending: Arc<Pending>,
    next_id: AtomicU64,
}

impl RpcConn {
    /// Start the reader and writer tasks. The `Incoming` receiver closes
    /// when the agent's stdout does (EOF or a read error); every request
    /// still in flight then fails with "connection closed".
    pub fn start<R, W>(reader: R, writer: W) -> (Arc<RpcConn>, mpsc::UnboundedReceiver<Incoming>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        let (in_tx, in_rx) = mpsc::unbounded_channel::<Incoming>();
        let pending: Arc<Pending> = Arc::new(Mutex::new(HashMap::new()));

        let mut writer = writer;
        tauri::async_runtime::spawn(async move {
            while let Some(line) = out_rx.recv().await {
                if writer.write_all(line.as_bytes()).await.is_err()
                    || writer.write_all(b"\n").await.is_err()
                    || writer.flush().await.is_err()
                {
                    break;
                }
            }
            // Dropping the writer closes the agent's stdin, which is how
            // ACP agents are asked to exit.
        });

        let pending_r = pending.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            loop {
                let line = match lines.next_line().await {
                    Ok(Some(l)) => l,
                    Ok(None) => break,
                    Err(e) => {
                        tracing::debug!(?e, "acp: stdout read failed");
                        break;
                    }
                };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let msg: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(e) => {
                        // Some adapters log to stdout by mistake; skip it.
                        tracing::debug!(?e, line = %truncate(line, 200), "acp: non-JSON line");
                        continue;
                    }
                };
                dispatch(msg, &pending_r, &in_tx);
            }
            let waiting: Vec<_> = pending_r.lock().drain().collect();
            for (_, tx) in waiting {
                let _ = tx.send(Err(closed()));
            }
        });

        (
            Arc::new(RpcConn {
                out: out_tx,
                pending,
                next_id: AtomicU64::new(1),
            }),
            in_rx,
        )
    }

    pub async fn request(&self, method: &str, params: impl Serialize) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.out.send(msg.to_string()).is_err() {
            self.pending.lock().remove(&id);
            return Err(closed());
        }
        rx.await.unwrap_or_else(|_| Err(closed()))
    }

    pub fn notify(&self, method: &str, params: impl Serialize) {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.out.send(msg.to_string());
    }

    pub fn respond(&self, id: Value, result: impl Serialize) {
        let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        let _ = self.out.send(msg.to_string());
    }

    pub fn respond_error(&self, id: Value, code: i64, message: &str) {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        });
        let _ = self.out.send(msg.to_string());
    }
}

fn closed() -> RpcError {
    RpcError {
        code: -32099,
        message: "agent connection closed".into(),
        detail: None,
    }
}

fn dispatch(mut msg: Value, pending: &Pending, incoming: &mpsc::UnboundedSender<Incoming>) {
    let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
    let id = msg.get_mut("id").map(Value::take).filter(|v| !v.is_null());
    match (method, id) {
        (Some(method), Some(id)) => {
            let params = msg.get_mut("params").map(Value::take).unwrap_or(Value::Null);
            let _ = incoming.send(Incoming::Request { id, method, params });
        }
        (Some(method), None) => {
            let params = msg.get_mut("params").map(Value::take).unwrap_or(Value::Null);
            let _ = incoming.send(Incoming::Notification { method, params });
        }
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else {
                return;
            };
            let Some(tx) = pending.lock().remove(&id) else {
                return;
            };
            let result = match msg.get_mut("error") {
                Some(err) if !err.is_null() => Err(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string(),
                    detail: err.get("data").and_then(|d| match d {
                        Value::String(s) => Some(s.clone()),
                        Value::Null => None,
                        other => Some(other.to_string()),
                    }),
                }),
                _ => Ok(msg.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
            };
            let _ = tx.send(result);
        }
        (None, None) => {}
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn requests_resolve_and_agent_requests_surface() {
        // Two pipes: client→agent and agent→client.
        let (client_out, agent_in) = duplex(4096);
        let (mut agent_out, client_in) = duplex(4096);
        let (conn, mut incoming) = RpcConn::start(client_in, client_out);
        let mut agent_lines = BufReader::new(agent_in).lines();

        let c = conn.clone();
        let call = tokio::spawn(async move { c.request("initialize", json!({"x": 1})).await });
        let sent: Value =
            serde_json::from_str(&agent_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(sent["method"], "initialize");
        assert_eq!(sent["params"]["x"], 1);

        // A stray log line, a notification, an agent request, then the answer.
        let id = sent["id"].clone();
        let script = format!(
            "not json\n{}\n{}\n{}\n",
            json!({"jsonrpc":"2.0","method":"session/update","params":{"a":1}}),
            json!({"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{}}),
            json!({"jsonrpc":"2.0","id":id,"result":{"ok":true}}),
        );
        agent_out.write_all(script.as_bytes()).await.unwrap();

        assert_eq!(call.await.unwrap().unwrap()["ok"], true);
        match incoming.recv().await.unwrap() {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "session/update");
                assert_eq!(params["a"], 1);
            }
            other => panic!("{other:?}"),
        }
        match incoming.recv().await.unwrap() {
            Incoming::Request { id, method, .. } => {
                assert_eq!(method, "session/request_permission");
                conn.respond(id, json!({"outcome": {"outcome": "cancelled"}}));
            }
            other => panic!("{other:?}"),
        }
        let reply: Value =
            serde_json::from_str(&agent_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(reply["id"], "p1");
        assert_eq!(reply["result"]["outcome"]["outcome"], "cancelled");
    }

    #[tokio::test]
    async fn errors_and_eof_fail_requests() {
        let (client_out, agent_in) = duplex(4096);
        let (mut agent_out, client_in) = duplex(4096);
        let (conn, mut incoming) = RpcConn::start(client_in, client_out);
        let mut agent_lines = BufReader::new(agent_in).lines();

        let c = conn.clone();
        let call = tokio::spawn(async move { c.request("session/new", json!({})).await });
        let sent: Value =
            serde_json::from_str(&agent_lines.next_line().await.unwrap().unwrap()).unwrap();
        let err = json!({"jsonrpc":"2.0","id":sent["id"],"error":{"code":-32000,"message":"auth"}});
        agent_out
            .write_all(format!("{err}\n").as_bytes())
            .await
            .unwrap();
        let e = call.await.unwrap().unwrap_err();
        assert_eq!(e.code, AUTH_REQUIRED);

        let c = conn.clone();
        let call = tokio::spawn(async move { c.request("session/prompt", json!({})).await });
        let _ = agent_lines.next_line().await.unwrap();
        drop(agent_out);
        assert!(call.await.unwrap().is_err());
        assert!(incoming.recv().await.is_none());
    }
}
