//! Minimal MCP Streamable-HTTP transport: JSON-RPC over `POST /mcp`, always
//! answered with a plain `application/json` body (the spec lets servers skip
//! SSE when they have nothing to stream). We implement the handful of methods
//! a tools-only server needs rather than pull in a full SDK.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

use super::{tools, McpCaller};

/// Newest first; we echo the client's version when we know it.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "You are running inside treehouse, a desktop app that runs \
coding agents in parallel git worktrees. Use create_worktree to split independent pieces \
of work into sibling worktrees, each with its own agent seeded with a prompt. The user sees \
them appear in treehouse's sidebar and reviews/merges them there.

Whenever you need a new git worktree, ALWAYS use create_worktree. NEVER run \
`git worktree add` (in any form) and never use Claude Code's built-in worktree features \
(the EnterWorktree tool, or subagents with worktree isolation). Worktrees made those ways \
land outside treehouse's layout: they get no treehouse agent, and the user can't see, \
review, or merge them from the app.";

/// Bind the server and record its port. Called once from `setup()`; on
/// failure agents simply launch without treehouse tools.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(?e, "mcp: bind failed; agents will run without treehouse tools");
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(e) => {
                tracing::warn!(?e, "mcp: no local addr");
                return;
            }
        };
        let _ = app.state::<AppState>().mcp.port.set(port);
        tracing::info!(port, "mcp server listening");
        let router = Router::new()
            .route("/mcp", post(handle).get(no_stream).delete(no_stream))
            .with_state(app);
        if let Err(e) = axum::serve(listener, router).await {
            tracing::warn!(?e, "mcp server exited");
        }
    });
}

/// No server-initiated stream and no sessions to terminate.
async fn no_stream() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

async fn handle(State(app): State<AppHandle>, headers: HeaderMap, body: Json<Value>) -> Response {
    let Some(caller) = authenticate(&app, &headers) else {
        return (StatusCode::UNAUTHORIZED, "invalid or expired treehouse token").into_response();
    };
    let Json(body) = body;
    let responses: Vec<Value> = match body {
        Value::Array(batch) => {
            let mut out = Vec::new();
            for msg in batch {
                if let Some(r) = dispatch(&app, caller, msg).await {
                    out.push(r);
                }
            }
            if out.is_empty() {
                return StatusCode::ACCEPTED.into_response();
            }
            return Json(Value::Array(out)).into_response();
        }
        msg => dispatch(&app, caller, msg).await.into_iter().collect(),
    };
    match responses.into_iter().next() {
        Some(r) => Json(r).into_response(),
        // Notifications and client responses get a bare 202.
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Bearer token → caller, only while the minting agent is still alive.
fn authenticate(app: &AppHandle, headers: &HeaderMap) -> Option<McpCaller> {
    let token = headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?
        .trim();
    let state = app.state::<AppState>();
    let caller = state.mcp.resolve(token)?;
    if !crate::agent::supervisor::is_live(&state.agents, caller.agent_id) {
        state.mcp.revoke(token);
        return None;
    }
    Some(caller)
}

/// Handle one JSON-RPC message. `None` for anything that isn't a request
/// (notifications, stray responses).
async fn dispatch(app: &AppHandle, caller: McpCaller, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str)?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::list(caller.scope) })),
        "tools/call" => Ok(tools::call(app, caller, &params).await),
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    })
}

fn initialize(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    let version = requested
        .filter(|v| PROTOCOL_VERSIONS.contains(v))
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": super::SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}
