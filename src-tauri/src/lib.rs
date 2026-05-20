mod agent;
mod diff;
mod fs_api;
mod fs_watch;
mod ipc;
mod lsp;
mod pty;
mod state;
mod storage;
mod user_config;
mod util;
mod workspace;
mod worktree;

#[cfg(test)]
mod test_support;

use state::AppState;

/// macOS log directory for the app. We compute this directly rather
/// than going through Tauri's `app.path().app_log_dir()` because
/// `tracing` has to be initialized before the Tauri builder runs —
/// startup tracing (PATH import, supervisor spawn, etc.) would
/// otherwise be lost.
fn log_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join("Library/Logs/com.treehouse.app"))
}

pub fn run() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "treehouse_lib=debug".into());

    // Stderr layer — visible in `npm run tauri dev` and when the
    // bundled app is launched from a terminal. ANSI escapes on so
    // dev output stays colorful.
    let stderr_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    // File layer — daily-rotated log at
    // `~/Library/Logs/com.treehouse.app/treehouse.log`. Survives app
    // restart so users can paste relevant slices when something
    // misbehaves in the released DMG (where stderr is launchd-eaten
    // and devtools are disabled). Best-effort: a missing $HOME or a
    // failed mkdir falls through silently to stderr-only.
    let mut file_guard: Option<tracing_appender::non_blocking::WorkerGuard> = None;
    let file_layer = log_dir().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        let appender = tracing_appender::rolling::daily(&dir, "treehouse.log");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        file_guard = Some(guard);
        Some(
            tracing_subscriber::fmt::layer()
                .with_writer(writer)
                .with_ansi(false),
        )
    });

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(file_layer)
        .init();

    // The non-blocking writer's WorkerGuard must outlive the process
    // — drop it and pending lines are lost. Box::leak is the
    // standard escape hatch for "lives until exit". Acceptable since
    // we only ever construct one.
    if let Some(guard) = file_guard {
        Box::leak(Box::new(guard));
    }

    tracing::info!("treehouse starting; logs at ~/Library/Logs/com.treehouse.app/treehouse.log");

    import_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                use tauri::Manager as _;
                let app = window.app_handle();
                let state = app.state::<AppState>();
                state.agents.kill_all();
                state.terminals.kill_all();
                state.lsp.kill_all();
                tracing::info!("graceful shutdown: killed agents + terminals + lsp");
            }
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::open_workspace,
            ipc::commands::close_workspace,
            ipc::commands::list_recent_workspaces,
            ipc::commands::open_external_url,
            ipc::commands::get_settings,
            ipc::commands::update_settings,
            ipc::commands::list_comments,
            ipc::commands::save_comments,
            ipc::commands::list_worktrees,
            ipc::commands::create_worktree,
            ipc::commands::remove_worktree,
            ipc::commands::merge_worktree,
            ipc::commands::sync_worktree,
            ipc::commands::get_diff,
            ipc::commands::read_file,
            ipc::commands::write_file,
            ipc::commands::read_blob_at_ref,
            ipc::commands::list_tree,
            ipc::commands::list_files,
            ipc::commands::open_terminal,
            ipc::commands::pty_write,
            ipc::commands::pty_resize,
            ipc::commands::close_terminal,
            ipc::commands::attach_terminal,
            ipc::commands::list_terminals_for_worktree,
            ipc::commands::launch_agent,
            ipc::commands::agent_write,
            ipc::commands::agent_resize,
            ipc::commands::kill_agent,
            ipc::commands::list_agents_for_worktree,
            ipc::commands::list_backend_agents,
            ipc::commands::attach_agent,
            ipc::commands::list_agent_activity,
            ipc::commands::lsp_ensure,
            ipc::commands::lsp_write,
            ipc::commands::lsp_kill,
            ipc::commands::lsp_kill_for_worktree,
            ipc::commands::lsp_list,
            ipc::commands::lsp_list_configs,
            ipc::commands::lsp_resolve_command,
            ipc::commands::treehouse_config_reload,
            ipc::commands::treehouse_config_open_file,
            ipc::commands::open_logs_folder,
            ipc::commands::read_app_text_file,
            ipc::commands::list_log_files,
            ipc::commands::worktree_setup_steps,
            ipc::commands::worktree_mark_setup_ran,
        ])
        .setup(|app| {
            use tauri::Manager;
            tracing::info!("treehouse started");
            let handle = app.handle().clone();
            let state: tauri::State<AppState> = handle.state();
            if let Err(e) = state.agents.start_hook_watcher(&handle) {
                tracing::warn!(?e, "failed to start Claude hook watcher");
            }
            // First-boot migration: legacy per-feature TOMLs →
            // unified `treehouse.toml`. Idempotent — only runs when
            // the unified file is absent and at least one legacy is
            // present. Renames legacies to `*.toml.bak` on success.
            // Done before the patterns load below so post-migration
            // patterns are read from the new location.
            //
            // Ordering: settings.json may be rewritten by migrate()
            // (to fold in legacy `enabled` flags), so this runs
            // before any subsystem that depends on settings.
            let handle_for_config = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = user_config::migrate(&handle_for_config).await {
                    tracing::warn!(?e, "treehouse.toml migration failed");
                }
                match agent::patterns::load(&handle_for_config).await {
                    Ok(p) => {
                        let state: tauri::State<AppState> =
                            handle_for_config.state();
                        state.agents.set_patterns(p);
                    }
                    Err(e) => {
                        tracing::warn!(?e, "failed to load agent status patterns");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running treehouse");
}

/// Mac `.app` bundles launched from Finder / launchd inherit a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) — `.zshrc` / `.zprofile` never run, so
/// user-managed dirs like `~/.local/bin`, `/opt/homebrew/bin`, or
/// language-manager shims are missing. Subprocess spawns (agents, LSP
/// servers) then fail to find binaries the user can invoke fine from a
/// terminal.
///
/// Remedy: shell out once to the user's login shell with an interactive +
/// login flag so the full init chain runs, capture `$PATH`, then export it
/// into our own env. All subsequent `CommandBuilder` spawns inherit it.
///
/// Best-effort: on any failure (non-zero exit, empty output, timeout-ish)
/// we leave the existing PATH alone. Keeps ~/.zshrc stderr out of our log.
fn import_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = match std::process::Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            tracing::debug!(?e, %shell, "shell PATH import: spawn failed");
            return;
        }
    };
    if !output.status.success() {
        tracing::debug!(status = ?output.status, "shell PATH import: nonzero exit");
        return;
    }
    let captured = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if captured.is_empty() {
        return;
    }
    tracing::info!(path = %captured, "imported PATH from login shell");
    std::env::set_var("PATH", captured);
}
