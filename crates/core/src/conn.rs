//! Connection plumbing: TLS, per-profile pools, session setup, error mapping and
//! the cancel registry.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use deadpool_postgres::{Hook, HookError, Manager, ManagerConfig, Pool, PoolError, RecyclingMethod, Runtime};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, ring};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::{CancelToken, Client, Config};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::model::{ConnProfile, SslMode};
use crate::{AppError, AppResult};

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const POOL_MAX: usize = 4;
/// How long a command waits for a free pooled session before giving up.
const POOL_WAIT: Duration = Duration::from_secs(60);

/// libpq `sslmode=prefer/require` semantics: the channel is encrypted and the
/// handshake signature is checked, but the certificate chain is not validated
/// (managed hosts such as Supabase use private CAs that are not in the system store).
#[derive(Debug)]
struct EncryptOnlyVerifier(Arc<CryptoProvider>);

impl ServerCertVerifier for EncryptOnlyVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Shared TLS connector. Whether TLS is actually negotiated is decided by the
/// `ssl_mode` on the tokio-postgres `Config`.
static TLS: LazyLock<MakeRustlsConnect> = LazyLock::new(|| {
    let provider = Arc::new(ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("ring provider supports the default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(EncryptOnlyVerifier(provider)))
        .with_no_client_auth();
    MakeRustlsConnect::new(config)
});

pub(crate) fn tls() -> MakeRustlsConnect {
    TLS.clone()
}

fn pg_config(profile: &ConnProfile, password: Option<&str>, ssl: PgSslMode) -> Config {
    let mut cfg = Config::new();
    if profile.host.starts_with('/') {
        cfg.host_path(&profile.host);
    } else {
        cfg.host(&profile.host);
    }
    cfg.port(profile.port)
        .user(&profile.user)
        .dbname(&profile.database)
        .application_name("pgview")
        .connect_timeout(CONNECT_TIMEOUT)
        .ssl_mode(ssl);
    if let Some(pw) = password {
        cfg.password(pw);
    }
    cfg
}

/// SETs applied to every new session, and re-applied after `run_sql`/exports so
/// user-issued SETs never leak into the pool.
pub(crate) fn session_setup_sql(profile: &ConnProfile) -> String {
    let mut sql = format!(
        "SET application_name = 'pgview'; SET statement_timeout = {}",
        profile.statement_timeout_ms
    );
    if profile.read_only {
        sql.push_str("; SET default_transaction_read_only = on");
    }
    sql
}

async fn connect_once(cfg: &Config) -> Result<Client, AppError> {
    let fut = cfg.connect(tls());
    let (client, connection) = match tokio::time::timeout(CONNECT_TIMEOUT, fut).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return Err(map_connect_error(e)),
        Err(_) => {
            return Err(AppError::Connect {
                message: format!("timed out after {}s", CONNECT_TIMEOUT.as_secs()),
            });
        }
    };
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            tracing::debug!("postgres connection closed: {e}");
        }
    });
    Ok(client)
}

/// Opens one standalone session (no pool). For `Prefer`, a failed TLS handshake
/// is retried without TLS. Returns the client and the ssl mode that worked.
pub(crate) async fn open_client(profile: &ConnProfile, password: Option<&str>) -> AppResult<(Client, PgSslMode)> {
    let modes: &[PgSslMode] = match profile.ssl {
        SslMode::Disable => &[PgSslMode::Disable],
        SslMode::Require => &[PgSslMode::Require],
        SslMode::Prefer => &[PgSslMode::Prefer, PgSslMode::Disable],
    };
    let mut last_err = None;
    for &mode in modes {
        match connect_once(&pg_config(profile, password, mode)).await {
            Ok(client) => return Ok((client, mode)),
            Err(AppError::Connect { message }) if mode == PgSslMode::Prefer && message.starts_with(TLS_HANDSHAKE_ERR) => {
                tracing::debug!("TLS handshake failed, retrying without TLS: {message}");
                last_err = Some(AppError::Connect { message });
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::internal("no connection attempt made")))
}

const TLS_HANDSHAKE_ERR: &str = "error performing TLS handshake";

/// Pool of up to 4 sessions; each new session runs [`session_setup_sql`].
pub(crate) fn build_pool(profile: &ConnProfile, password: Option<&str>, ssl: PgSslMode) -> AppResult<Pool> {
    let manager = Manager::from_config(
        pg_config(profile, password, ssl),
        tls(),
        ManagerConfig { recycling_method: RecyclingMethod::Fast },
    );
    let setup: Arc<str> = session_setup_sql(profile).into();
    Pool::builder(manager)
        .max_size(POOL_MAX)
        .runtime(Runtime::Tokio1)
        .create_timeout(Some(CONNECT_TIMEOUT))
        .wait_timeout(Some(POOL_WAIT))
        .post_create(Hook::async_fn(move |client, _| {
            let setup = setup.clone();
            Box::pin(async move { client.batch_execute(&setup).await.map_err(HookError::Backend) })
        }))
        .build()
        .map_err(|e| AppError::internal(format!("building connection pool: {e}")))
}

fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        out.push_str(": ");
        out.push_str(&s.to_string());
        source = s.source();
    }
    out
}

/// Errors raised while establishing a session.
pub(crate) fn map_connect_error(e: tokio_postgres::Error) -> AppError {
    if let Some(db) = e.as_db_error() {
        let message = db.message().to_owned();
        return if db.code().code().starts_with("28") {
            AppError::Auth { message }
        } else {
            AppError::Connect { message }
        };
    }
    let message = error_chain(&e);
    if message.starts_with("authentication error") {
        AppError::Auth { message }
    } else {
        AppError::Connect { message }
    }
}

/// Errors raised by a statement. `user_cancelled` decides how SQLSTATE 57014 maps.
pub(crate) fn map_query_error(e: tokio_postgres::Error, user_cancelled: bool) -> AppError {
    let Some(db) = e.as_db_error() else {
        return AppError::Connect { message: error_chain(&e) };
    };
    let code = db.code().code();
    if code == "57014" {
        return if user_cancelled { AppError::Cancelled } else { AppError::Timeout };
    }
    if code.starts_with("28") {
        return AppError::Auth { message: db.message().to_owned() };
    }
    AppError::Sql {
        code: code.to_owned(),
        message: db.message().to_owned(),
        detail: db.detail().map(str::to_owned),
        hint: db.hint().map(str::to_owned),
        position: match db.position() {
            Some(ErrorPosition::Original(p)) => Some(*p),
            _ => None,
        },
    }
}

pub(crate) fn map_pool_error(e: PoolError) -> AppError {
    match e {
        PoolError::Backend(e) | PoolError::PostCreateHook(HookError::Backend(e)) => map_connect_error(e),
        PoolError::PostCreateHook(HookError::Message(message)) => AppError::Connect { message: message.into_owned() },
        PoolError::Timeout(_) => AppError::Connect { message: "timed out waiting for a database session".into() },
        PoolError::Closed => AppError::NotConnected,
        PoolError::NoRuntimeSpecified => AppError::internal("connection pool has no runtime"),
    }
}

#[derive(Default)]
struct RegistryInner {
    tokens: HashMap<String, CancelToken>,
    cancelled: HashSet<String>,
}

/// In-flight requests by `request_id`, plus which of them the user cancelled.
#[derive(Default)]
pub(crate) struct CancelRegistry {
    inner: Mutex<RegistryInner>,
}

impl CancelRegistry {
    pub(crate) fn register(&self, request_id: &str, token: CancelToken) -> CancelGuard<'_> {
        let mut inner = self.inner.lock().expect("cancel registry poisoned");
        inner.cancelled.remove(request_id);
        inner.tokens.insert(request_id.to_owned(), token);
        CancelGuard { registry: self, request_id: request_id.to_owned() }
    }

    /// Marks the request cancelled and returns its token, if it is in flight.
    pub(crate) fn begin_cancel(&self, request_id: &str) -> Option<CancelToken> {
        let mut inner = self.inner.lock().expect("cancel registry poisoned");
        let token = inner.tokens.get(request_id).cloned()?;
        inner.cancelled.insert(request_id.to_owned());
        Some(token)
    }

    fn was_cancelled(&self, request_id: &str) -> bool {
        self.inner.lock().expect("cancel registry poisoned").cancelled.contains(request_id)
    }
}

/// Unregisters the request on drop.
pub(crate) struct CancelGuard<'a> {
    registry: &'a CancelRegistry,
    request_id: String,
}

impl CancelGuard<'_> {
    pub(crate) fn map_err(&self, e: tokio_postgres::Error) -> AppError {
        map_query_error(e, self.registry.was_cancelled(&self.request_id))
    }
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.registry.inner.lock() {
            inner.tokens.remove(&self.request_id);
            inner.cancelled.remove(&self.request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(read_only: bool) -> ConnProfile {
        ConnProfile {
            id: uuid::Uuid::nil(),
            name: "t".into(),
            host: "localhost".into(),
            port: 5432,
            database: "db".into(),
            user: "u".into(),
            ssl: SslMode::Disable,
            read_only,
            color: None,
            statement_timeout_ms: 1500,
        }
    }

    #[test]
    fn setup_sql_respects_read_only() {
        assert_eq!(
            session_setup_sql(&profile(true)),
            "SET application_name = 'pgview'; SET statement_timeout = 1500; SET default_transaction_read_only = on"
        );
        assert_eq!(
            session_setup_sql(&profile(false)),
            "SET application_name = 'pgview'; SET statement_timeout = 1500"
        );
    }
}
