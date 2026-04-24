mod agent;
mod diff;
mod fs_api;
mod fs_watch;
mod ipc;
mod lsp;
mod pty;
mod state;
mod storage;
mod util;
mod workspace;
mod worktree;

#[cfg(test)]
mod test_support;

use state::AppState;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "treehouse_lib=debug".into()),
        )
        .init();

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
            ipc::commands::list_tree,
            ipc::commands::open_terminal,
            ipc::commands::pty_write,
            ipc::commands::pty_resize,
            ipc::commands::close_terminal,
            ipc::commands::launch_agent,
            ipc::commands::agent_write,
            ipc::commands::agent_resize,
            ipc::commands::kill_agent,
            ipc::commands::list_agents_for_worktree,
            ipc::commands::attach_agent,
            ipc::commands::list_agent_activity,
            ipc::commands::lsp_ensure,
            ipc::commands::lsp_write,
            ipc::commands::lsp_kill,
            ipc::commands::lsp_list,
            ipc::commands::lsp_list_configs,
            ipc::commands::lsp_save_config,
            ipc::commands::lsp_resolve_command,
        ])
        .setup(|app| {
            use tauri::Manager;
            tracing::info!("treehouse started");
            let handle = app.handle().clone();
            let state: tauri::State<AppState> = handle.state();
            if let Err(e) = state.agents.start_hook_watcher(&handle) {
                tracing::warn!(?e, "failed to start Claude hook watcher");
            }
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
