mod agent;
mod diff;
mod fs_api;
mod fs_watch;
mod ipc;
mod pty;
mod state;
mod storage;
mod util;
mod workspace;
mod worktree;

use state::AppState;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "treehouse_lib=debug".into()),
        )
        .init();

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
                tracing::info!("graceful shutdown: killed agents + terminals");
            }
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::open_workspace,
            ipc::commands::close_workspace,
            ipc::commands::list_recent_workspaces,
            ipc::commands::list_worktrees,
            ipc::commands::create_worktree,
            ipc::commands::remove_worktree,
            ipc::commands::merge_worktree,
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
            ipc::commands::get_agent_for_worktree,
            ipc::commands::attach_agent,
            ipc::commands::list_agent_activity,
        ])
        .setup(|_app| {
            tracing::info!("treehouse started");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running treehouse");
}
