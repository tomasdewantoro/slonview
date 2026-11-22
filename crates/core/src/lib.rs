//! slonview-core: all PostgreSQL, config, and secret logic. No Tauri dependency.
pub mod activity;
pub mod completion;
pub mod config;
pub mod connurl;
pub mod engine;
pub mod error;
pub mod explain;
pub mod history;
pub mod model;
pub mod saved;
pub mod secrets;
pub mod update;

mod conn;
mod edit;
mod export;
mod ident;
mod introspect;
mod objects;
mod paging;
mod query;
mod split;
mod ssh;

pub use engine::Engine;
pub use error::{AppError, AppResult};
