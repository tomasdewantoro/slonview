//! Dev-only HTTP bridge for headless E2E runs (never shipped; examples are not bundled).
//! Serves `POST /invoke/<command>` on 127.0.0.1:1499 with the same JSON args object the
//! frontend passes to `invoke`, and dispatches to the same `pgview_lib::ops` functions the
//! Tauri commands call. Errors are HTTP 400 with the serialized `AppError`.
//!
//! Profiles and history live in a temp dir (`PGVIEW_E2E_DIR` or a fresh one), never in the
//! real app data directory; passwords go to the real macOS Keychain.
//!
//! Run: `cargo run -p pgview --example e2e_bridge`
use std::path::PathBuf;
use std::sync::Arc;

use pgview_core::config::ProfileStore;
use pgview_core::history::HistoryStore;
use pgview_core::secrets::KeychainStore;
use pgview_core::{AppError, Engine};
use pgview_lib::ops::{self, PasswordUpdate};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const ADDR: &str = "127.0.0.1:1499";

type Args = Map<String, Value>;

fn arg<T: DeserializeOwned>(args: &Args, key: &str) -> Result<T, AppError> {
    let value = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|e| AppError::invalid(format!("invalid args.{key}: {e}")))
}

fn ok<T: Serialize>(value: T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|e| AppError::internal(e.to_string()))
}

async fn dispatch(engine: &Engine, cmd: &str, a: &Args) -> Result<Value, AppError> {
    match cmd {
        "list_profiles" => ok(ops::list_profiles(engine).await?),
        "save_profile" => {
            let password = PasswordUpdate::from_json(a.get("password")).map_err(AppError::invalid)?;
            ok(ops::save_profile(engine, arg(a, "profile")?, password).await?)
        }
        "delete_profile" => ok(ops::delete_profile(engine, arg(a, "id")?).await?),
        "parse_conn_url" => ok(ops::parse_conn_url(&arg::<String>(a, "url")?).await?),
        "import_pgpass" => ok(ops::import_pgpass().await?),
        "test_connection" => {
            let password: Option<String> = arg(a, "password")?;
            ok(ops::test_connection(engine, &arg(a, "profile")?, password.as_deref()).await?)
        }
        "connect" => ok(ops::connect(engine, arg(a, "connId")?).await?),
        "disconnect" => ok(ops::disconnect(engine, arg(a, "connId")?).await?),
        "list_schema_tree" => ok(ops::list_schema_tree(engine, arg(a, "connId")?).await?),
        "describe_table" => ok(ops::describe_table(
            engine,
            arg(a, "connId")?,
            &arg::<String>(a, "schema")?,
            &arg::<String>(a, "table")?,
        )
        .await?),
        "fetch_page" => ok(ops::fetch_page(engine, &arg(a, "requestId")?, &arg(a, "req")?).await?),
        "count_exact" => {
            let raw_where: Option<String> = arg(a, "rawWhere")?;
            ok(ops::count_exact(
                engine,
                &arg(a, "requestId")?,
                arg(a, "connId")?,
                &arg::<String>(a, "schema")?,
                &arg::<String>(a, "table")?,
                &arg::<Vec<_>>(a, "filters")?,
                raw_where.as_deref(),
            )
            .await?)
        }
        "get_cell" => ok(ops::get_cell(engine, &arg(a, "req")?).await?),
        "run_sql" => ok(ops::run_sql(
            engine,
            &arg(a, "requestId")?,
            arg(a, "connId")?,
            &arg::<String>(a, "sql")?,
            arg(a, "maxRows")?,
        )
        .await?),
        "cancel_query" => ok(ops::cancel_query(engine, &arg(a, "requestId")?).await?),
        "export_csv" => ok(ops::export_csv(
            engine,
            &arg(a, "requestId")?,
            &arg(a, "source")?,
            &arg::<String>(a, "path")?,
        )
        .await?),
        "list_history" => {
            let search: Option<String> = arg(a, "search")?;
            ok(ops::list_history(engine, arg(a, "connId")?, search.as_deref(), arg(a, "limit")?).await?)
        }
        "clear_history" => ok(ops::clear_history(engine).await?),
        // Test-only probe: reads the Keychain from this process (which created the item), so
        // E2E scripts never run `security -w`, which can raise an access prompt.
        "e2e_keychain_get" => ok(engine.secrets.get(arg(a, "id")?)?),
        other => Err(AppError::invalid(format!("unknown command {other}"))),
    }
}

/// Reads one HTTP/1.1 request: (method, path, body).
async fn read_request(stream: &mut TcpStream) -> std::io::Result<(String, String, Vec<u8>)> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or_default().split(' ');
    let method = start.next().unwrap_or_default().to_owned();
    let path = start.next().unwrap_or_default().to_owned();
    let len = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buf[header_end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok((method, path, body))
}

async fn respond(stream: &mut TcpStream, status: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: content-type\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

async fn handle(engine: Arc<Engine>, mut stream: TcpStream) -> std::io::Result<()> {
    let (method, path, body) = read_request(&mut stream).await?;
    if method == "OPTIONS" {
        return respond(&mut stream, "204 No Content", b"").await;
    }
    let Some(cmd) = path.strip_prefix("/invoke/").filter(|_| method == "POST") else {
        return respond(&mut stream, "404 Not Found", b"null").await;
    };
    let args: Args = if body.is_empty() {
        Args::new()
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(Value::Object(m)) => m,
            Ok(Value::Null) => Args::new(),
            _ => {
                let err = serde_json::to_vec(&AppError::invalid("args must be a JSON object")).unwrap();
                return respond(&mut stream, "400 Bad Request", &err).await;
            }
        }
    };
    let result = dispatch(&engine, cmd, &args).await;
    match &result {
        Ok(_) => tracing::info!(cmd, "ok"),
        Err(e) => tracing::warn!(cmd, error = %e, "error"),
    }
    match result {
        Ok(v) => respond(&mut stream, "200 OK", &serde_json::to_vec(&v).unwrap()).await,
        Err(e) => respond(&mut stream, "400 Bad Request", &serde_json::to_vec(&e).unwrap()).await,
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let dir = match std::env::var_os("PGVIEW_E2E_DIR") {
        Some(d) => PathBuf::from(d),
        None => std::env::temp_dir().join(format!("pgview-e2e-{}", std::process::id())),
    };
    std::fs::create_dir_all(&dir)?;
    let engine = Arc::new(Engine::new(
        ProfileStore::new(dir.join("connections.toml")),
        Arc::new(KeychainStore),
        HistoryStore::new(dir.join("history.jsonl")),
    ));
    let listener = TcpListener::bind(ADDR).await?;
    tracing::info!(addr = ADDR, dir = %dir.display(), "e2e bridge listening");
    loop {
        let (stream, _) = listener.accept().await?;
        let engine = engine.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(engine, stream).await {
                tracing::warn!(error = %e, "connection error");
            }
        });
    }
}
