//! Server activity (`pg_stat_activity`) for the current database, and cancelling or terminating
//! a backend. Signals are not data writes: cancel works on read-only connections; terminate is
//! refused there by the engine itself.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::ConnId;
use crate::{AppError, AppResult, Engine, conn};

/// One row of `pg_stat_activity`. Ages are measured on the server (`clock_timestamp()`), so the
/// client's clock does not matter; the UI adds the time since the list arrived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Activity {
    pub pid: i32,
    pub user: Option<String>,
    pub application_name: String,
    /// Client address, or None for Unix-socket and background processes.
    pub client_addr: Option<String>,
    /// active, idle, idle in transaction, … (None for background processes).
    pub state: Option<String>,
    /// `wait_event_type: wait_event`, when waiting.
    pub wait_event: Option<String>,
    pub backend_type: String,
    /// Milliseconds since the transaction started.
    pub xact_age_ms: Option<f64>,
    /// Milliseconds since the current (or last) query started.
    pub query_age_ms: Option<f64>,
    pub query: String,
    /// The session that ran this list: Slonview's own.
    pub is_self: bool,
    /// The current role may cancel this backend: its own role (or a role it is a member of),
    /// or `pg_signal_backend` for non-superuser backends, or a superuser.
    pub can_signal: bool,
}

const ACTIVITY_SQL: &str = "
    WITH me AS (SELECT current_setting('is_superuser') = 'on' AS su,
                       pg_has_role('pg_signal_backend', 'MEMBER') AS signal)
    SELECT a.pid, a.usename::text, coalesce(a.application_name, ''), host(a.client_addr), a.state,
           CASE WHEN a.wait_event IS NOT NULL THEN a.wait_event_type || ': ' || a.wait_event END,
           coalesce(a.backend_type, ''),
           (extract(epoch FROM clock_timestamp() - a.xact_start) * 1000)::float8,
           (extract(epoch FROM clock_timestamp() - a.query_start) * 1000)::float8,
           coalesce(a.query, ''),
           a.pid = pg_backend_pid(),
           a.pid <> pg_backend_pid() AND a.usesysid IS NOT NULL AND (
             me.su OR pg_has_role(a.usesysid, 'MEMBER')
             OR (me.signal AND NOT coalesce((SELECT r.rolsuper FROM pg_roles r WHERE r.oid = a.usesysid), true))
           )
    FROM pg_stat_activity a, me
    WHERE a.datname = current_database()
      AND ($1 OR a.state IS DISTINCT FROM 'idle' OR a.pid = pg_backend_pid())
    ORDER BY a.pid = pg_backend_pid() DESC, a.xact_start NULLS LAST, a.pid";

impl Engine {
    /// Sessions on the connection's database; idle ones only with `include_idle`.
    /// Slonview's own session is always listed (first).
    pub async fn list_activity(
        &self,
        conn_id: ConnId,
        include_idle: bool,
    ) -> AppResult<Vec<Activity>> {
        let (_, client) = self.client(conn_id).await?;
        let rows = client
            .query(ACTIVITY_SQL, &[&include_idle])
            .await
            .map_err(|e| conn::map_query_error(e, false))?;
        Ok(rows
            .iter()
            .map(|r| Activity {
                pid: r.get(0),
                user: r.get(1),
                application_name: r.get(2),
                client_addr: r.get(3),
                state: r.get(4),
                wait_event: r.get(5),
                backend_type: r.get(6),
                xact_age_ms: r.get(7),
                query_age_ms: r.get(8),
                query: r.get(9),
                is_self: r.get(10),
                can_signal: r.get(11),
            })
            .collect())
    }

    /// `pg_cancel_backend(pid)`, or `pg_terminate_backend(pid)` when `terminate`. Returns the
    /// server's answer (false: no such backend any more). Terminate needs Allow writes.
    pub async fn signal_backend(
        &self,
        conn_id: ConnId,
        pid: i32,
        terminate: bool,
    ) -> AppResult<bool> {
        let (session, client) = self.client(conn_id).await?;
        if terminate && session.profile.read_only {
            return Err(AppError::invalid(
                "Read-only connection: terminating a session is not allowed. Turn on “Allow writes” for this connection to terminate sessions.",
            ));
        }
        let sql = if terminate {
            "SELECT pg_terminate_backend($1)"
        } else {
            "SELECT pg_cancel_backend($1)"
        };
        let row = client
            .query_one(sql, &[&pid])
            .await
            .map_err(|e| conn::map_query_error(e, false))?;
        Ok(row.get(0))
    }
}
