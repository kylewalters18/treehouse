//! Per-worktree preview browser: a native child webview laid over the
//! bottom pane's Browser tab.
//!
//! Native rather than an `<iframe>` so the previewed page is a top-level
//! document: its COOP/COEP headers apply (`crossOriginIsolated`, needed
//! for `SharedArrayBuffer`), and its cookies aren't third-party. The
//! renderer owns layout — it measures a placeholder element and sends
//! its rect here; Rust just places, shows, and hides the webviews.
//!
//! No registry: each worktree's webview is found by its label. They're
//! children of the main window, so they close with it.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, Url, Webview,
    WebviewBuilder, WebviewUrl, Window,
};
use ts_rs::TS;

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::WorktreeId;

const LABEL_PREFIX: &str = "browser-";

/// Event carrying the preview's URL after each page load, so the
/// address bar follows in-page navigation.
pub const NAVIGATED_EVENT: &str = "browser://navigated";

/// Placeholder rect in the main webview's CSS pixels, plus the main
/// webview's CSS viewport width. The ratio of the window's logical
/// width to that viewport width is the page zoom (⌘= / ⌘-), which the
/// rect has to be scaled by to land in window coordinates.
#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub viewport_width: f64,
    /// Emulated device width in CSS px (e.g. 402 for an iPhone 16 Pro),
    /// or null to let the page fill the rect at 100%. The rect keeps the
    /// device's aspect ratio but may be scaled down to fit, so the page
    /// is zoomed to make its viewport exactly this wide.
    pub device_width: Option<f64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrowserNavigated {
    pub worktree_id: WorktreeId,
    pub url: String,
}

/// True for a preview-browser webview (vs the app's own UI).
pub fn is_preview<R: Runtime>(webview: &Webview<R>) -> bool {
    webview.label().starts_with(LABEL_PREFIX)
}

fn label(worktree_id: WorktreeId) -> String {
    format!("{LABEL_PREFIX}{worktree_id}")
}

fn parse_url(url: &str) -> AppResult<Url> {
    let parsed = Url::parse(url).map_err(|e| AppError::Unknown(format!("bad url {url}: {e}")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        s => Err(AppError::Unknown(format!(
            "browser: only http/https are allowed (got {s})"
        ))),
    }
}

fn tauri_err(e: tauri::Error) -> AppError {
    AppError::Unknown(format!("browser: {e}"))
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> AppResult<Window<R>> {
    app.get_window("main")
        .ok_or_else(|| AppError::Unknown("browser: no main window".into()))
}

fn previews<R: Runtime>(app: &AppHandle<R>) -> impl Iterator<Item = Webview<R>> {
    app.webviews().into_values().filter(is_preview)
}

/// `bounds` in window coordinates, plus the page zoom for the preview.
fn placement<R: Runtime>(window: &Window<R>, b: BrowserBounds) -> AppResult<(Rect, f64)> {
    let scale = window.scale_factor().map_err(tauri_err)?;
    let inner = window
        .inner_size()
        .map_err(tauri_err)?
        .to_logical::<f64>(scale);
    let zoom = if b.viewport_width > 0.0 {
        inner.width / b.viewport_width
    } else {
        1.0
    };
    let rect = Rect {
        position: LogicalPosition::new(b.x * zoom, b.y * zoom).into(),
        size: LogicalSize::new(b.width * zoom, b.height * zoom).into(),
    };
    let page_zoom = match b.device_width {
        Some(dw) if dw > 0.0 => b.width * zoom / dw,
        _ => 1.0,
    };
    Ok((rect, page_zoom))
}

/// Show `worktree_id`'s preview at `bounds`, creating it at `url` if it
/// doesn't exist yet. Every other preview is hidden — one is visible at
/// a time. An existing preview keeps whatever page it's on; use
/// [`navigate`] to change it.
pub fn show<R: Runtime>(
    app: &AppHandle<R>,
    worktree_id: WorktreeId,
    url: &str,
    bounds: BrowserBounds,
) -> AppResult<()> {
    let label = label(worktree_id);
    for w in previews(app).filter(|w| w.label() != label) {
        let _ = w.hide();
    }
    let window = main_window(app)?;
    let (rect, page_zoom) = placement(&window, bounds)?;
    if let Some(webview) = app.get_webview(&label) {
        webview.set_bounds(rect).map_err(tauri_err)?;
        webview.set_zoom(page_zoom).map_err(tauri_err)?;
        webview.show().map_err(tauri_err)?;
        return Ok(());
    }

    let url = parse_url(url)?;
    let emitter = app.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url)).on_page_load(
        move |_webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let _ = emitter.emit(
                NAVIGATED_EVENT,
                BrowserNavigated {
                    worktree_id,
                    url: payload.url().to_string(),
                },
            );
        },
    );
    // `add_child` hops to the main thread and blocks on the result, so
    // this must not itself run on the main thread (commands are async).
    let webview = window
        .add_child(builder, rect.position, rect.size)
        .map_err(tauri_err)?;
    webview.set_zoom(page_zoom).map_err(tauri_err)?;
    tracing::debug!(%worktree_id, "created preview webview");
    Ok(())
}

pub fn hide_all<R: Runtime>(app: &AppHandle<R>) {
    for w in previews(app) {
        let _ = w.hide();
    }
}

/// Point an existing preview at `url`. No-op if the worktree has no
/// preview yet — the next [`show`] creates it at the renderer's URL.
pub fn navigate<R: Runtime>(
    app: &AppHandle<R>,
    worktree_id: WorktreeId,
    url: &str,
) -> AppResult<()> {
    let url = parse_url(url)?;
    if let Some(webview) = app.get_webview(&label(worktree_id)) {
        webview.navigate(url).map_err(tauri_err)?;
    }
    Ok(())
}

pub fn reload<R: Runtime>(app: &AppHandle<R>, worktree_id: WorktreeId) -> AppResult<()> {
    if let Some(webview) = app.get_webview(&label(worktree_id)) {
        webview.reload().map_err(tauri_err)?;
    }
    Ok(())
}

pub fn close<R: Runtime>(app: &AppHandle<R>, worktree_id: WorktreeId) {
    if let Some(webview) = app.get_webview(&label(worktree_id)) {
        let _ = webview.close();
    }
}
