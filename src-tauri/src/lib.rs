mod commands;
pub mod ops;
mod state;

use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            use tauri::Manager;
            app.manage(state::build_engine()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::conn::list_profiles,
            commands::conn::save_profile,
            commands::conn::delete_profile,
            commands::conn::parse_conn_url,
            commands::conn::import_pgpass,
            commands::conn::test_connection,
            commands::conn::connect,
            commands::conn::disconnect,
            commands::schema::list_schema_tree,
            commands::schema::describe_table,
            commands::schema::get_function_definition,
            commands::data::fetch_page,
            commands::data::count_exact,
            commands::data::get_cell,
            commands::sql::run_sql,
            commands::sql::cancel_query,
            commands::export::export_csv,
            commands::history::list_history,
            commands::history::clear_history,
            commands::objects::get_object_definition,
            commands::grid::stream_columns,
            commands::grid::edit_info,
            commands::grid::get_edit_row,
            commands::grid::review_edits,
            commands::grid::apply_edits,
            commands::sql_assist::list_columns,
            commands::sql_assist::explain,
            commands::connections::set_time_zone,
            commands::connections::save_ssh_secret,
            commands::connections::test_tunnel_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
