//! Dev-only HTTP bridge for headless E2E runs (never shipped; examples are not bundled).
//! Serves `POST /invoke/<command>` on `SLONVIEW_BRIDGE_ADDR` (default 127.0.0.1:1499) with the
//! same JSON args object the frontend passes to `invoke`, and dispatches to the same
//! `slonview_lib::ops` functions the Tauri commands call. Errors are HTTP 400 with the
//! serialized `AppError`.
//!
//! Profiles and history live in a temp dir (`SLONVIEW_E2E_DIR` or a fresh one), never in the
//! real app data directory; passwords go to the real OS credential store.
//!
//! Run: `cargo run -p slonview --example e2e_bridge`
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use slonview_core::config::ProfileStore;
use slonview_core::history::HistoryStore;
use slonview_core::secrets::OsSecretStore;
use slonview_core::{AppError, Engine};
use slonview_lib::ops::{self, PasswordUpdate};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const DEFAULT_ADDR: &str = "127.0.0.1:1499";

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
            let password =
                PasswordUpdate::from_json(a.get("password")).map_err(AppError::invalid)?;
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
        "get_function_definition" => {
            ok(ops::get_function_definition(engine, arg(a, "connId")?, arg(a, "oid")?).await?)
        }
        "fetch_page" => ok(ops::fetch_page(engine, &arg(a, "requestId")?, &arg(a, "req")?).await?),
        "count_exact" => {
            let raw_where: Option<String> = arg(a, "rawWhere")?;
            let search: Option<String> = arg(a, "search")?;
            ok(ops::count_exact(
                engine,
                &arg(a, "requestId")?,
                arg(a, "connId")?,
                &arg::<String>(a, "schema")?,
                &arg::<String>(a, "table")?,
                &arg::<Vec<_>>(a, "filters")?,
                search.as_deref(),
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
            ok(ops::list_history(
                engine,
                arg(a, "connId")?,
                search.as_deref(),
                arg(a, "limit")?,
            )
            .await?)
        }
        "clear_history" => ok(ops::clear_history(engine).await?),
        "get_object_definition" => ok(ops::get_object_definition(
            engine,
            arg(a, "connId")?,
            arg(a, "kind")?,
            arg(a, "oid")?,
        )
        .await?),
        "list_columns" => ok(ops::list_columns(engine, arg(a, "connId")?).await?),
        "explain" => ok(ops::explain(
            engine,
            &arg(a, "requestId")?,
            arg(a, "connId")?,
            &arg::<String>(a, "sql")?,
            arg(a, "analyze")?,
        )
        .await?),
        // Test-only probe: reads the credential store from this process (which created the item), so
        // E2E scripts never run `security -w`, which can raise an access prompt.
        "e2e_keychain_get" => ok(engine.secrets.get(arg(a, "id")?)?),
        "set_time_zone" => {
            ok(ops::set_time_zone(engine, arg(a, "connId")?, arg(a, "timeZone")?).await?)
        }
        "save_ssh_secret" => {
            let value: Option<String> = arg(a, "value")?;
            ok(ops::save_ssh_secret(
                engine,
                arg(a, "id")?,
                arg(a, "passphrase")?,
                value.as_deref(),
            )
            .await?)
        }
        "test_tunnel_connection" => {
            let password: Option<String> = arg(a, "password")?;
            let secret: Option<String> = arg(a, "sshSecret")?;
            ok(ops::test_tunnel_connection(
                engine,
                &arg(a, "profile")?,
                password.as_deref(),
                secret.as_deref(),
            )
            .await?)
        }
        "edit_info" => ok(ops::edit_info(
            engine,
            arg(a, "connId")?,
            &arg::<String>(a, "schema")?,
            &arg::<String>(a, "table")?,
        )
        .await?),
        "get_edit_row" => ok(ops::get_edit_row(engine, &arg(a, "req")?).await?),
        "review_edits" => ok(ops::review_edits(engine, &arg(a, "req")?).await?),
        "apply_edits" => {
            ok(ops::apply_edits(engine, &arg::<String>(a, "requestId")?, &arg(a, "req")?).await?)
        }
        // v0.3.0 navigation
        "list_referencing" => ok(ops::list_referencing(
            engine,
            arg(a, "connId")?,
            &arg::<String>(a, "schema")?,
            &arg::<String>(a, "table")?,
        )
        .await?),
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
                let err =
                    serde_json::to_vec(&AppError::invalid("args must be a JSON object")).unwrap();
                return respond(&mut stream, "400 Bad Request", &err).await;
            }
        }
    };
    if cmd == "stream_columns" {
        let request_id: String = arg(&args, "requestId").map_err(std::io::Error::other)?;
        let req = arg(&args, "req").map_err(std::io::Error::other)?;
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").await?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let produce = async {
            let result = ops::stream_columns(&engine, &request_id, &req, |chunk| {
                tx.send(serde_json::json!({ "chunk": chunk }))
                    .map_err(|_| AppError::Cancelled)
            })
            .await;
            let last = match result {
                Ok(summary) => serde_json::json!({ "done": summary }),
                Err(error) => serde_json::json!({ "error": error }),
            };
            let _ = tx.send(last);
            drop(tx);
        };
        let consume = async {
            while let Some(value) = rx.recv().await {
                let mut bytes = serde_json::to_vec(&value).map_err(std::io::Error::other)?;
                bytes.push(b'\n');
                stream.write_all(&bytes).await?;
            }
            stream.shutdown().await
        };
        let (_, result) = tokio::join!(produce, consume);
        return result;
    }
    let result = dispatch(&engine, cmd, &args).await;
    match &result {
        Ok(_) => tracing::info!(cmd, "ok"),
        Err(e) => tracing::warn!(cmd, error = %e, "error"),
    }
    match result {
        Ok(v) => respond(&mut stream, "200 OK", &serde_json::to_vec(&v).unwrap()).await,
        Err(e) => {
            respond(
                &mut stream,
                "400 Bad Request",
                &serde_json::to_vec(&e).unwrap(),
            )
            .await
        }
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let dir = match std::env::var_os("SLONVIEW_E2E_DIR") {
        Some(d) => PathBuf::from(d),
        None => std::env::temp_dir().join(format!("slonview-e2e-{}", std::process::id())),
    };
    std::fs::create_dir_all(&dir)?;
    let engine = Arc::new(Engine::new(
        ProfileStore::new(dir.join("connections.toml")),
        Arc::new(OsSecretStore),
        HistoryStore::new(dir.join("history.jsonl")),
    ));
    let addr = std::env::var("SLONVIEW_BRIDGE_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_owned());
    let listener = TcpListener::bind(&addr).await?;
    tracing::info!(addr = %addr, dir = %dir.display(), "e2e bridge listening");
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
