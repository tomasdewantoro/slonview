//! SSH transport. Never learns host keys implicitly; OpenSSH owns known_hosts.
use crate::model::{SshAuth, SshConfig};
use crate::{AppError, AppResult};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate, agent::client::AgentClient};
use russh::{ChannelStream, client};
use std::path::PathBuf;
use std::sync::Arc;

struct HostVerifier {
    host: String,
    port: u16,
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        ssh_error(e)
    }
}

impl client::Handler for HostVerifier {
    type Error = AppError;
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> AppResult<bool> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Err(ssh_error(
                "SSH host certificates are not supported; use a pinned host key in ~/.ssh/known_hosts",
            ));
        };
        match russh::keys::check_known_hosts(&self.host, self.port, key) {
            Ok(true) => Ok(true),
            Ok(false) => Err(ssh_error(format!(
                "Unknown SSH host {}. Run `ssh {}{}` once to verify and save its host key, then reconnect.",
                self.host,
                if self.port == 22 {
                    String::new()
                } else {
                    format!("-p {} ", self.port)
                },
                self.host
            ))),
            Err(russh::keys::Error::KeyChanged { line }) => Err(ssh_error(format!(
                "SSH host key mismatch for {} (known_hosts line {line}). Connection refused. Verify the server identity before changing ~/.ssh/known_hosts.",
                self.host
            ))),
            Err(e) => Err(ssh_error(format!("Cannot verify ~/.ssh/known_hosts: {e}"))),
        }
    }
}

pub(crate) struct Tunnel {
    handle: client::Handle<HostVerifier>,
}

impl Tunnel {
    pub(crate) async fn connect(config: &SshConfig, secret: Option<&str>) -> AppResult<Arc<Self>> {
        if config.host.trim().is_empty() || config.user.trim().is_empty() || config.port == 0 {
            return Err(AppError::invalid(
                "SSH host, user and a valid port are required",
            ));
        }
        let options = client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        };
        let mut handle = client::connect(
            Arc::new(options),
            (config.host.as_str(), config.port),
            HostVerifier {
                host: config.host.clone(),
                port: config.port,
            },
        )
        .await?;
        let authenticated = match &config.auth {
            SshAuth::Password => handle
                .authenticate_password(
                    &config.user,
                    secret.ok_or_else(|| {
                        ssh_error("SSH password is missing. Edit the connection to save it.")
                    })?,
                )
                .await?
                .success(),
            SshAuth::Key { path } => {
                let path = expand_home(path)?;
                let key = russh::keys::load_secret_key(&path, secret).map_err(|e| {
                    ssh_error(format!("Cannot load SSH key {}: {e}", path.display()))
                })?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                handle
                    .authenticate_publickey(
                        &config.user,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await?
                    .success()
            }
            SshAuth::Agent => {
                let mut agent = AgentClient::connect_env().await.map_err(|e| {
                    ssh_error(format!("Cannot connect to SSH agent (SSH_AUTH_SOCK): {e}"))
                })?;
                let identities = agent.request_identities().await.map_err(ssh_error)?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                let mut success = false;
                for identity in identities {
                    if handle
                        .authenticate_publickey_with(
                            &config.user,
                            identity.public_key().into_owned(),
                            hash,
                            &mut agent,
                        )
                        .await
                        .map_err(ssh_error)?
                        .success()
                    {
                        success = true;
                        break;
                    }
                }
                success
            }
        };
        if !authenticated {
            return Err(ssh_error(format!(
                "SSH authentication rejected for {}@{}",
                config.user, config.host
            )));
        }
        Ok(Arc::new(Self { handle }))
    }

    /// Each database session and cancellation uses its own direct-tcpip channel.
    pub(crate) async fn stream(
        &self,
        host: &str,
        port: u16,
    ) -> AppResult<ChannelStream<client::Msg>> {
        if host.starts_with('/') {
            return Err(AppError::invalid(
                "SSH tunneling requires a PostgreSQL TCP host, not a Unix socket directory",
            ));
        }
        Ok(self
            .handle
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
            .await?
            .into_stream())
    }
}

fn expand_home(path: &str) -> AppResult<PathBuf> {
    if let Some(rest) = path.strip_prefix("~/") {
        let dirs = directories::BaseDirs::new()
            .ok_or_else(|| ssh_error("Cannot determine home directory"))?;
        Ok(dirs.home_dir().join(rest))
    } else {
        Ok(PathBuf::from(path))
    }
}

fn ssh_error(e: impl std::fmt::Display) -> AppError {
    AppError::Ssh {
        message: e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn local_sshd_key_auth_when_available() {
        if tokio::net::TcpStream::connect(("127.0.0.1", 22))
            .await
            .is_err()
        {
            eprintln!(
                "SKIP SSH integration: no sshd reachable on localhost:22; Remote Login remains unchanged."
            );
            return;
        }
        let home = directories::BaseDirs::new().unwrap();
        let key = home.home_dir().join(".ssh/id_ed25519");
        if !key.exists() {
            eprintln!(
                "SKIP SSH integration: ~/.ssh/id_ed25519 is unavailable for key authentication."
            );
            return;
        }
        let status = std::process::Command::new("ssh")
            .args([
                "-oBatchMode=yes",
                "-oStrictHostKeyChecking=yes",
                "-oConnectTimeout=3",
                "localhost",
                "true",
            ])
            .status()
            .unwrap();
        if !status.success() {
            eprintln!("SKIP SSH integration: localhost key authentication is unavailable.");
            return;
        }
        let config = SshConfig {
            host: "localhost".into(),
            port: 22,
            user: std::env::var("USER").unwrap(),
            auth: SshAuth::Key {
                path: key.to_string_lossy().into_owned(),
            },
        };
        let tunnel = Tunnel::connect(&config, None).await.unwrap();
        let mut stream = tunnel.stream("127.0.0.1", 5432).await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        stream
            .write_all(&[0, 0, 0, 8, 4, 210, 22, 47])
            .await
            .unwrap();
        let mut response = [0];
        stream.read_exact(&mut response).await.unwrap();
        assert!(matches!(response[0], b'S' | b'N'));
    }
}
