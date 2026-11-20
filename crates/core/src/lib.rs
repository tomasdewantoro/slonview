//! pgview-core: all PostgreSQL, config, and secret logic. No Tauri dependency.
pub mod config;
pub mod engine;
pub mod connurl;
pub mod error;
pub mod history;
pub mod model;
pub mod secrets;

pub use error::{AppError, AppResult};
pub use engine::Engine;
