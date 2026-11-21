//! Tauri commands. Names and argument keys mirror `src/api.ts` exactly
//! (Tauri maps camelCase JS keys to these snake_case parameters).
//! Every command is `async` so database and disk work never runs on the main thread.
pub mod conn;
pub mod connections;
pub mod data;
pub mod export;
pub mod grid;
pub mod history;
pub mod objects;
pub mod schema;
pub mod sql;
pub mod sql_assist;
