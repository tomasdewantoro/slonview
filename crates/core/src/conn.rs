//! Connection plumbing: TLS, per-profile pools, session setup, error mapping and
//! the cancel registry.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use deadpool::managed::{Hook, HookError, PoolError};
use deadpool::Runtime;
use deadpool_postgres::ClientWrapper;
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

pub(crate) type Pool = deadpool::managed::Pool<ConnectionManager>;
pub(crate) type Object = deadpool::managed::Object<ConnectionManager>;

/// verify-ca differs from verify-full only by omitting the name check; all
/// signature, validity, purpose and chain checks still run in WebPki.
#[derive(Debug)]
struct CaVerifier(Arc<rustls::client::WebPkiServerVerifier>);
impl ServerCertVerifier for CaVerifier {
    fn verify_server_cert(&self, cert: &CertificateDer<'_>, chain: &[CertificateDer<'_>], name: &ServerName<'_>, ocsp: &[u8], now: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        match self.0.verify_server_cert(cert, chain, name, ocsp, now) {
            Err(rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName | rustls::CertificateError::NotValidForNameContext { .. })) => Ok(ServerCertVerified::assertion()),
            result => result,
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, s: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> { self.0.verify_tls12_signature(m,c,s) }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, s: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> { self.0.verify_tls13_signature(m,c,s) }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> { self.0.supported_verify_schemes() }
}

fn verifier(profile: &ConnProfile) -> AppResult<Arc<dyn ServerCertVerifier>> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    if let Some(path) = &profile.ssl_root_cert {
        let file = std::fs::File::open(path).map_err(|e| AppError::Tls { message: format!("Cannot open CA file {path}: {e}") })?;
        let certs = rustls_pemfile::certs(&mut std::io::BufReader::new(file)).collect::<Result<Vec<_>,_>>().map_err(|e| AppError::Tls { message: format!("Invalid PEM CA file: {e}") })?;
        if certs.is_empty() { return Err(AppError::Tls { message: "CA file contains no PEM certificates".into() }); }
        for cert in certs { roots.add(cert).map_err(|e| AppError::Tls { message: format!("Invalid CA certificate: {e}") })?; }
    }
    let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::new(ring::default_provider())).build().map_err(|e| AppError::Tls { message: e.to_string() })?;
    Ok(if profile.ssl == SslMode::VerifyCa { Arc::new(CaVerifier(verifier)) } else { verifier })
}

fn profile_tls(profile: &ConnProfile) -> AppResult<MakeRustlsConnect> {
    if !matches!(profile.ssl, SslMode::VerifyCa | SslMode::VerifyFull) { return Ok(TLS.clone()); }
    Ok(MakeRustlsConnect::new(rustls::ClientConfig::builder_with_provider(Arc::new(ring::default_provider())).with_safe_default_protocol_versions().expect("TLS versions").dangerous().with_custom_certificate_verifier(verifier(profile)?).with_no_client_auth()))
}

#[derive(Clone)]
pub(crate) struct Transport {
    tls: MakeRustlsConnect,
    tunnel: Option<Arc<crate::ssh::Tunnel>>,
    host: String,
    port: u16,
}
impl Transport {
    pub(crate) async fn new(profile: &ConnProfile, secret: Option<&str>) -> AppResult<Self> {
        let tls = profile_tls(profile)?;
        let tunnel = match &profile.ssh {
            Some(config) => Some(tokio::time::timeout(CONNECT_TIMEOUT, crate::ssh::Tunnel::connect(config, secret)).await.map_err(|_| AppError::Ssh { message: "SSH connection timed out after 10s".into() })??),
            None => None,
        };
        Ok(Self { tls, tunnel, host: profile.host.clone(), port: profile.port })
    }
    pub(crate) async fn cancel(&self, token: &CancelToken) -> AppResult<()> {
        use tokio_postgres::tls::MakeTlsConnect;
        if let Some(tunnel) = &self.tunnel {
            let stream: russh::ChannelStream<russh::client::Msg> = tunnel.stream(&self.host, self.port).await?;
            let mut maker = self.tls.clone();
            let tls = MakeTlsConnect::<russh::ChannelStream<russh::client::Msg>>::make_tls_connect(&mut maker, &self.host).expect("infallible TLS connector");
            token.cancel_query_raw(stream, tls).await.map_err(map_connect_error)
        } else { token.cancel_query(self.tls.clone()).await.map_err(map_connect_error) }
    }
    async fn connect(&self, cfg: &Config) -> AppResult<(Client, tokio::task::JoinHandle<()>)> {
        use tokio_postgres::tls::MakeTlsConnect;
        if let Some(tunnel) = &self.tunnel {
            let stream: russh::ChannelStream<russh::client::Msg> = tunnel.stream(&self.host, self.port).await?;
            let mut maker = self.tls.clone();
            let tls = MakeTlsConnect::<russh::ChannelStream<russh::client::Msg>>::make_tls_connect(&mut maker, &self.host).expect("infallible TLS connector");
            let (client, connection) = cfg.connect_raw(stream, tls).await.map_err(map_connect_error)?;
            let keep_alive = self.tunnel.clone();
            Ok((client, tokio::spawn(async move { let _tunnel = keep_alive; if let Err(e) = connection.await { tracing::debug!("postgres connection closed: {e}"); } })))
        } else {
            let (client, connection) = cfg.connect(self.tls.clone()).await.map_err(map_connect_error)?;
            Ok((client, tokio::spawn(async move { if let Err(e) = connection.await { tracing::debug!("postgres connection closed: {e}"); } })))
        }
    }
}

pub(crate) struct ConnectionManager { config: Config, transport: Transport }
impl deadpool::managed::Manager for ConnectionManager {
    type Type = ClientWrapper;
    type Error = AppError;
    async fn create(&self) -> AppResult<ClientWrapper> {
        let (client, task) = self.transport.connect(&self.config).await?;
        Ok(ClientWrapper::new(client, task))
    }
    async fn recycle(&self, client: &mut ClientWrapper, _: &deadpool::managed::Metrics) -> deadpool::managed::RecycleResult<AppError> {
        if client.is_closed() { Err(deadpool::managed::RecycleError::message("Connection closed")) } else { Ok(()) }
    }
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
        .application_name("slonview")
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
        "SET application_name = 'slonview'; SET statement_timeout = {}",
        profile.statement_timeout_ms
    );
    if profile.read_only {
        sql.push_str("; SET default_transaction_read_only = on");
    }
    if let Some(tz) = &profile.time_zone {
        sql.push_str("; SET TIME ZONE ");
        sql.push_str(&crate::ident::quote_literal(tz));
    }
    sql
}

async fn connect_once(cfg: &Config, transport: &Transport) -> AppResult<Client> {
    let (client, _) = tokio::time::timeout(CONNECT_TIMEOUT, transport.connect(cfg)).await.map_err(|_| AppError::Connect { message: "timed out after 10s".into() })??;
    Ok(client)
}

/// Opens one standalone session (no pool). For `Prefer`, a failed TLS handshake
/// is retried without TLS. Returns the client and the ssl mode that worked.
pub(crate) async fn open_client(profile: &ConnProfile, password: Option<&str>, transport: &Transport) -> AppResult<(Client, PgSslMode)> {
    let modes: &[PgSslMode] = match profile.ssl {
        SslMode::Disable => &[PgSslMode::Disable],
        SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => &[PgSslMode::Require],
        SslMode::Prefer => &[PgSslMode::Prefer, PgSslMode::Disable],
    };
    let mut last_err = None;
    for &mode in modes {
        match connect_once(&pg_config(profile, password, mode), transport).await {
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
pub(crate) fn build_pool(profile: &ConnProfile, password: Option<&str>, ssl: PgSslMode, transport: Transport) -> AppResult<Pool> {
    let manager = ConnectionManager { config: pg_config(profile, password, ssl), transport };
    let setup: Arc<str> = session_setup_sql(profile).into();
    Pool::builder(manager)
        .max_size(POOL_MAX)
        .runtime(Runtime::Tokio1)
        .create_timeout(Some(CONNECT_TIMEOUT))
        .wait_timeout(Some(POOL_WAIT))
        .post_create(Hook::async_fn(move |client: &mut ClientWrapper, _| {
            let setup = setup.clone();
            Box::pin(async move { client.batch_execute(&setup).await.map_err(map_connect_error).map_err(HookError::Backend) })
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
    if message.contains("UnknownIssuer") || message.contains("unknown issuer") {
        return AppError::Tls { message: "Unknown certificate issuer. Choose the server's CA PEM file or install its CA in the system trust store.".into() };
    }
    if message.contains("NotValidForName") || message.contains("not valid for name") {
        return AppError::Tls { message: "Certificate hostname mismatch. Use the hostname listed in the server certificate.".into() };
    }
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

pub(crate) fn map_pool_error(e: PoolError<AppError>) -> AppError {
    match e {
        PoolError::Backend(e) | PoolError::PostCreateHook(HookError::Backend(e)) => e,
        PoolError::PostCreateHook(HookError::Message(message)) => AppError::Connect { message: message.into_owned() },
        PoolError::Timeout(_) => AppError::Connect { message: "timed out waiting for a database session".into() },
        PoolError::Closed => AppError::NotConnected,
        PoolError::NoRuntimeSpecified => AppError::internal("connection pool has no runtime"),
    }
}

#[derive(Default)]
struct RegistryInner {
    tokens: HashMap<String, (CancelToken, Transport)>,
    cancelled: HashSet<String>,
}

/// In-flight requests by `request_id`, plus which of them the user cancelled.
#[derive(Default)]
pub(crate) struct CancelRegistry {
    inner: Mutex<RegistryInner>,
}

impl CancelRegistry {
    pub(crate) fn register(&self, request_id: &str, token: CancelToken, transport: Transport) -> CancelGuard<'_> {
        let mut inner = self.inner.lock().expect("cancel registry poisoned");
        inner.cancelled.remove(request_id);
        inner.tokens.insert(request_id.to_owned(), (token, transport));
        CancelGuard { registry: self, request_id: request_id.to_owned() }
    }

    /// Marks the request cancelled and returns its token, if it is in flight.
    pub(crate) fn begin_cancel(&self, request_id: &str) -> Option<(CancelToken, Transport)> {
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
            time_zone: None,
            ssl_root_cert: None,
            ssh: None,
        }
    }

    #[test]
    fn setup_sql_respects_read_only() {
        assert_eq!(
            session_setup_sql(&profile(true)),
            "SET application_name = 'slonview'; SET statement_timeout = 1500; SET default_transaction_read_only = on"
        );
        assert_eq!(
            session_setup_sql(&profile(false)),
            "SET application_name = 'slonview'; SET statement_timeout = 1500"
        );
    }

    #[test]
    fn setup_sql_sets_quoted_time_zone() {
        let mut p = profile(true);
        p.time_zone = Some("Asia/Jakarta".into());
        assert!(session_setup_sql(&p).ends_with("; SET default_transaction_read_only = on; SET TIME ZONE 'Asia/Jakarta'"));
        p.time_zone = Some("x'; DROP TABLE t; --".into());
        assert!(session_setup_sql(&p).ends_with("; SET TIME ZONE 'x''; DROP TABLE t; --'"));
    }
    #[test]
    fn verified_tls_checks_chain_and_optional_hostname() {
        use rcgen::{CertificateParams, IsCa, BasicConstraints, KeyPair, Issuer};
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = CertificateParams::new(vec![]).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let issuer = Issuer::new(ca_params, ca_key);
        let key = KeyPair::generate().unwrap();
        let cert = CertificateParams::new(vec!["db.example.com".into()]).unwrap().signed_by(&key, &issuer).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("root.pem");
        std::fs::write(&path, ca.pem()).unwrap();
        let mut p = profile(true);
        p.ssl = SslMode::VerifyFull;
        p.ssl_root_cert = Some(path.to_string_lossy().into_owned());
        let valid = ServerName::try_from("db.example.com").unwrap();
        let wrong = ServerName::try_from("wrong.example.com").unwrap();
        let verifier_full = verifier(&p).unwrap();
        assert!(verifier_full.verify_server_cert(cert.der(), &[], &valid, &[], UnixTime::now()).is_ok());
        assert!(matches!(verifier_full.verify_server_cert(cert.der(), &[], &wrong, &[], UnixTime::now()), Err(rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForNameContext { .. } | rustls::CertificateError::NotValidForName))));
        p.ssl = SslMode::VerifyCa;
        assert!(verifier(&p).unwrap().verify_server_cert(cert.der(), &[], &wrong, &[], UnixTime::now()).is_ok());
        p.ssl_root_cert = None;
        for mode in [SslMode::VerifyCa, SslMode::VerifyFull] {
            p.ssl = mode;
            assert!(matches!(verifier(&p).unwrap().verify_server_cert(cert.der(), &[], &valid, &[], UnixTime::now()), Err(rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer))));
        }
    }

    #[test]
    fn cancel_connector_for_verify_full_is_webpki_not_encrypt_only() {
        // Transport::cancel reuses profile_tls(profile), so a verify-full profile cancels
        // through the WebPki connector, never the encrypt-only static TLS of prefer/require.
        let mut p = profile(true);
        p.ssl = SslMode::VerifyFull;
        assert!(profile_tls(&p).is_ok());
        let v = verifier(&p).unwrap();
        let cert = rcgen::CertificateParams::new(vec!["db.example.com".into()])
            .unwrap()
            .self_signed(&rcgen::KeyPair::generate().unwrap())
            .unwrap();
        let name = ServerName::try_from("db.example.com").unwrap();
        assert!(matches!(
            v.verify_server_cert(cert.der(), &[], &name, &[], UnixTime::now()),
            Err(rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer))
        ));
    }
}
