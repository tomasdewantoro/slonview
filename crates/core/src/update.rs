//! Manual update check: one GET to the GitHub releases API, only when the user clicks
//! **Check for updates**. Never runs on startup or on a timer.
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AppError, AppResult};

pub const RELEASES_URL: &str =
    "https://api.github.com/repos/tomasdewantoro/slonview/releases/latest";
/// Overrides [`RELEASES_URL`] (tests and the E2E harness point it at a local file server).
pub const UPDATE_URL_ENV: &str = "SLONVIEW_UPDATE_URL";
const TIMEOUT: Duration = Duration::from_secs(8);
/// The releases response is a few KB; anything far larger is not what we asked for.
const MAX_BODY: u64 = 1 << 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum UpdateStatus {
    #[serde(rename_all = "camelCase")]
    UpToDate { current: String },
    #[serde(rename_all = "camelCase")]
    Available {
        current: String,
        latest: String,
        /// Release page to open in the system browser.
        url: String,
    },
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: Option<String>,
}

/// Parses a release tag such as `v0.3.0` or `0.3.0`.
pub fn parse_tag(tag: &str) -> Option<semver::Version> {
    let t = tag.trim();
    semver::Version::parse(t.strip_prefix(['v', 'V']).unwrap_or(t)).ok()
}

/// Compares the latest release tag with `current` (a semver version, e.g. CARGO_PKG_VERSION).
pub fn compare(current: &str, tag: &str, url: Option<String>) -> AppResult<UpdateStatus> {
    let now = semver::Version::parse(current)
        .map_err(|e| AppError::internal(format!("app version {current} is not semver: {e}")))?;
    let latest = parse_tag(tag).ok_or_else(|| {
        AppError::internal(format!(
            "The latest release has an unexpected version tag ({tag})."
        ))
    })?;
    Ok(if latest > now {
        UpdateStatus::Available {
            current: now.to_string(),
            url: url.unwrap_or_else(|| {
                format!("https://github.com/tomasdewantoro/slonview/releases/tag/{tag}")
            }),
            latest: latest.to_string(),
        }
    } else {
        UpdateStatus::UpToDate {
            current: now.to_string(),
        }
    })
}

/// Fetches the latest release from `SLONVIEW_UPDATE_URL` (default [`RELEASES_URL`]) and
/// compares it with `current`. Blocking I/O runs on the blocking pool.
pub async fn check_for_updates(current: &str) -> AppResult<UpdateStatus> {
    let url = std::env::var(UPDATE_URL_ENV).unwrap_or_else(|_| RELEASES_URL.to_owned());
    let agent_name = format!("slonview/{current}");
    let release = tokio::task::spawn_blocking(move || fetch(&url, &agent_name))
        .await
        .map_err(|e| AppError::internal(format!("update check failed: {e}")))??;
    compare(current, &release.tag_name, release.html_url)
}

fn fetch(url: &str, user_agent: &str) -> AppResult<Release> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .user_agent(user_agent)
        .build()
        .into();
    let failed = |e: ureq::Error| AppError::Connect {
        message: format!("Couldn't reach {}: {e}", host_of(url)),
    };
    let mut response = agent
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(failed)?;
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_string()
        .map_err(failed)?;
    serde_json::from_str(&body)
        .map_err(|e| AppError::internal(format!("Unexpected answer from the update check: {e}")))
}

fn host_of(url: &str) -> &str {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn latest(current: &str, tag: &str) -> AppResult<UpdateStatus> {
        compare(current, tag, Some("https://example.invalid/r".into()))
    }

    #[test]
    fn newer_tag_is_available() {
        assert_eq!(
            latest("0.2.0", "v0.3.0").unwrap(),
            UpdateStatus::Available {
                current: "0.2.0".into(),
                latest: "0.3.0".into(),
                url: "https://example.invalid/r".into()
            }
        );
        // Semver order, not string order: 0.10.0 > 0.2.0.
        assert!(matches!(
            latest("0.2.0", "v0.10.0").unwrap(),
            UpdateStatus::Available { latest, .. } if latest == "0.10.0"
        ));
        assert!(matches!(
            latest("0.2.0", "0.2.1").unwrap(),
            UpdateStatus::Available { .. }
        ));
    }

    #[test]
    fn same_or_older_is_up_to_date() {
        for tag in ["v0.2.0", "0.2.0", "V0.2.0", "v0.1.9", " v0.2.0 "] {
            assert_eq!(
                latest("0.2.0", tag).unwrap(),
                UpdateStatus::UpToDate {
                    current: "0.2.0".into()
                },
                "{tag}"
            );
        }
        // A pre-release of the current version is older than the release.
        assert!(matches!(
            latest("0.3.0", "v0.3.0-rc.1").unwrap(),
            UpdateStatus::UpToDate { .. }
        ));
    }

    #[test]
    fn malformed_tags_are_errors() {
        for tag in [
            "",
            "v",
            "latest",
            "v0.3",
            "release-0.3.0",
            "vv0.3.0",
            "0.3.0.1",
        ] {
            assert!(
                matches!(latest("0.2.0", tag), Err(AppError::Internal { .. })),
                "{tag}"
            );
        }
    }

    #[test]
    fn missing_html_url_falls_back_to_tag_page() {
        assert!(matches!(
            compare("0.2.0", "v0.3.0", None).unwrap(),
            UpdateStatus::Available { url, .. }
                if url == "https://github.com/tomasdewantoro/slonview/releases/tag/v0.3.0"
        ));
    }

    #[test]
    fn host_for_messages() {
        assert_eq!(host_of(RELEASES_URL), "api.github.com");
        assert_eq!(host_of("http://127.0.0.1:9/x.json"), "127.0.0.1:9");
    }
}
