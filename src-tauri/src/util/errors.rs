use serde::{Serialize, Serializer};
use thiserror::Error;
use ts_rs::TS;

/// Errors surfaced to the frontend. `serialize` produces `{ kind, message }`
/// so React can switch on `kind` without parsing strings.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("path does not exist: {0}")]
    PathNotFound(String),

    #[error("not a git repository: {0}")]
    NotAGitRepo(String),

    #[error("git error: {0}")]
    GitError(String),

    #[error("i/o error: {0}")]
    Io(String),

    #[error("already open: {0}")]
    AlreadyOpen(String),

    #[error("{0}")]
    Unknown(String),
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct AppErrorPayload {
    pub kind: AppErrorKind,
    pub message: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub enum AppErrorKind {
    PathNotFound,
    NotAGitRepo,
    GitError,
    Io,
    AlreadyOpen,
    Unknown,
}

impl AppError {
    fn kind(&self) -> AppErrorKind {
        match self {
            AppError::PathNotFound(_) => AppErrorKind::PathNotFound,
            AppError::NotAGitRepo(_) => AppErrorKind::NotAGitRepo,
            AppError::GitError(_) => AppErrorKind::GitError,
            AppError::Io(_) => AppErrorKind::Io,
            AppError::AlreadyOpen(_) => AppErrorKind::AlreadyOpen,
            AppError::Unknown(_) => AppErrorKind::Unknown,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        AppErrorPayload {
            kind: self.kind(),
            message: self.to_string(),
        }
        .serialize(s)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<git2::Error> for AppError {
    fn from(e: git2::Error) -> Self {
        AppError::GitError(e.message().to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
