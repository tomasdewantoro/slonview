//! EXPLAIN for the SQL editor. `ANALYZE` executes the statement, so every explain runs
//! inside a transaction that is always rolled back (READ ONLY on read-only profiles), and
//! the text must Parse as exactly one server command first.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::engine::{reject_read_only, restore_session};
use crate::model::ConnId;
use crate::paging::RawSpan;
use crate::split::split_statements;
use crate::{AppError, AppResult, query};

/// One plan property shown as text (e.g. "Filter", "Index Cond", "Sort Key").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanDetail {
    pub key: String,
    pub value: String,
}

/// One node of an `EXPLAIN (FORMAT JSON)` plan. `actual_*` are set only with ANALYZE;
/// buffer counts only when the server reports them. Times are milliseconds per loop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanNode {
    pub node_type: String,
    /// `schema.relation` for scans, plus ` alias` when the alias differs.
    pub relation: Option<String>,
    pub index_name: Option<String>,
    /// Join type, scan direction, strategy or operation, e.g. "Inner", "Hashed".
    pub qualifier: Option<String>,
    pub startup_cost: f64,
    pub total_cost: f64,
    pub plan_rows: f64,
    pub plan_width: f64,
    pub actual_rows: Option<f64>,
    pub actual_total_time: Option<f64>,
    pub actual_loops: Option<f64>,
    pub shared_hit_blocks: Option<f64>,
    pub shared_read_blocks: Option<f64>,
    pub shared_dirtied_blocks: Option<f64>,
    pub shared_written_blocks: Option<f64>,
    pub temp_read_blocks: Option<f64>,
    pub temp_written_blocks: Option<f64>,
    /// Every other property (conditions, sort keys, output list…), in key order.
    pub details: Vec<PlanDetail>,
    pub children: Vec<PlanNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExplainResult {
    pub plan: PlanNode,
    pub analyzed: bool,
    pub planning_time_ms: Option<f64>,
    pub execution_time_ms: Option<f64>,
    /// The server's JSON output, pretty-printed.
    pub raw_json: String,
}

/// Properties mapped to typed fields (or recursed into) instead of `details`.
const TYPED_KEYS: &[&str] = &[
    "Node Type", "Plans", "Parent Relationship", "Relation Name", "Schema", "Alias", "Index Name",
    "Join Type", "Scan Direction", "Strategy", "Operation", "Partial Mode",
    "Startup Cost", "Total Cost", "Plan Rows", "Plan Width",
    "Actual Rows", "Actual Total Time", "Actual Startup Time", "Actual Loops",
    "Shared Hit Blocks", "Shared Read Blocks", "Shared Dirtied Blocks", "Shared Written Blocks",
    "Temp Read Blocks", "Temp Written Blocks", "Parallel Aware", "Async Capable",
];

fn explain_prefix(analyze: bool) -> &'static str {
    if analyze {
        "EXPLAIN (FORMAT JSON, VERBOSE, BUFFERS, COSTS, ANALYZE, TIMING) "
    } else {
        "EXPLAIN (FORMAT JSON, VERBOSE, BUFFERS, COSTS) "
    }
}

impl crate::engine::Engine {
    /// Plans `sql` (one statement); with `analyze` also runs it. Always rolled back.
    pub async fn explain(&self, request_id: &str, conn_id: ConnId, sql: &str, analyze: bool) -> AppResult<ExplainResult> {
        let mut statements = split_statements(sql);
        if statements.is_empty() {
            return Err(AppError::invalid("nothing to explain"));
        }
        if statements.len() > 1 {
            return Err(AppError::invalid("Explain needs exactly one SQL statement; select or place the cursor in one."));
        }
        let statement = statements.remove(0);
        let (session, client) = self.client(conn_id).await?;
        let read_only = session.profile.read_only;
        if read_only {
            reject_read_only(&statement)?;
        }
        let prefix = explain_prefix(analyze);
        let span = RawSpan { start: prefix.chars().count(), chars: statement.text.chars().count() };
        let explain_sql = format!("{prefix}{}", statement.text);
        let offset = |mut e: AppError| {
            if let AppError::Sql { position: Some(p), .. } | AppError::Invalid { position: Some(p), .. } = &mut e {
                *p += statement.char_offset as u32;
            }
            e
        };
        let guard = self.cancels.register(request_id, client.cancel_token(), session.transport.clone());
        let outcome = async {
            // Server Parse of the exact text that will run: more than one command is refused
            // in every mode before anything executes.
            query::require_single_statement(&client, &explain_sql, &guard)
                .await
                .map_err(|e| RawSpan::relocate(Some(span), e))?;
            let start = if read_only {
                Some(query::begin_read_only(&client, &guard).await?)
            } else {
                client.batch_execute("BEGIN").await.map_err(|e| guard.map_err(e))?;
                None
            };
            let messages = client
                .simple_query(&explain_sql)
                .await
                .map_err(|e| RawSpan::relocate(Some(span), guard.map_err(e)))?;
            if let Some(start) = &start {
                query::verify_read_only(&client, start, &guard).await?;
            }
            let json = messages
                .iter()
                .find_map(|m| match m {
                    tokio_postgres::SimpleQueryMessage::Row(row) => row.get(0).map(str::to_owned),
                    _ => None,
                })
                .ok_or_else(|| AppError::internal("EXPLAIN returned no plan"))?;
            parse_explain(&json, analyze)
        }
        .await
        .map_err(offset);
        drop(guard);
        // ROLLBACK undoes everything ANALYZE did; RESET ALL + profile setup clean the session.
        restore_session(client, &session.profile).await;
        outcome
    }
}

/// Parses the single-row output of `EXPLAIN (FORMAT JSON …)`.
pub(crate) fn parse_explain(json: &str, analyzed: bool) -> AppResult<ExplainResult> {
    let value: Value = serde_json::from_str(json).map_err(|e| AppError::internal(format!("parsing EXPLAIN output: {e}")))?;
    let top = value
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::internal("unexpected EXPLAIN output shape"))?;
    let plan = top
        .get("Plan")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::internal("EXPLAIN output has no Plan"))?;
    Ok(ExplainResult {
        plan: plan_node(plan),
        analyzed,
        planning_time_ms: top.get("Planning Time").and_then(Value::as_f64),
        execution_time_ms: top.get("Execution Time").and_then(Value::as_f64),
        raw_json: serde_json::to_string_pretty(&value).unwrap_or_else(|_| json.to_owned()),
    })
}

fn plan_node(node: &Map<String, Value>) -> PlanNode {
    let text = |key: &str| node.get(key).and_then(Value::as_str).map(str::to_owned);
    let num = |key: &str| node.get(key).and_then(Value::as_f64);
    let relation = text("Relation Name").map(|rel| {
        let qualified = match text("Schema") {
            Some(schema) => format!("{schema}.{rel}"),
            None => rel.clone(),
        };
        match text("Alias") {
            Some(alias) if alias != rel => format!("{qualified} {alias}"),
            _ => qualified,
        }
    });
    let qualifier = ["Join Type", "Scan Direction", "Strategy", "Operation", "Partial Mode"]
        .iter()
        .filter_map(|k| text(k))
        // "Forward" is the default scan direction and "Plain" the default strategy: noise.
        .filter(|v| v != "Forward" && v != "Plain")
        .collect::<Vec<_>>();
    let details = node
        .iter()
        .filter(|(k, _)| !TYPED_KEYS.contains(&k.as_str()))
        .map(|(k, v)| PlanDetail { key: k.clone(), value: detail_text(v) })
        .collect();
    let children = node
        .get("Plans")
        .and_then(Value::as_array)
        .map(|plans| plans.iter().filter_map(Value::as_object).map(plan_node).collect())
        .unwrap_or_default();
    PlanNode {
        node_type: text("Node Type").unwrap_or_default(),
        relation,
        index_name: text("Index Name"),
        qualifier: if qualifier.is_empty() { None } else { Some(qualifier.join(" ")) },
        startup_cost: num("Startup Cost").unwrap_or(0.0),
        total_cost: num("Total Cost").unwrap_or(0.0),
        plan_rows: num("Plan Rows").unwrap_or(0.0),
        plan_width: num("Plan Width").unwrap_or(0.0),
        actual_rows: num("Actual Rows"),
        actual_total_time: num("Actual Total Time"),
        actual_loops: num("Actual Loops"),
        shared_hit_blocks: num("Shared Hit Blocks"),
        shared_read_blocks: num("Shared Read Blocks"),
        shared_dirtied_blocks: num("Shared Dirtied Blocks"),
        shared_written_blocks: num("Shared Written Blocks"),
        temp_read_blocks: num("Temp Read Blocks"),
        temp_written_blocks: num("Temp Written Blocks"),
        details,
        children,
    }
}

fn detail_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(detail_text).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_plan_with_details() {
        let json = r#"[{"Plan": {"Node Type": "Hash Join", "Join Type": "Inner", "Startup Cost": 1.5, "Total Cost": 10.0,
            "Plan Rows": 100, "Plan Width": 8, "Actual Rows": 90, "Actual Loops": 1, "Actual Total Time": 2.5,
            "Hash Cond": "(o.customer_id = c.id)", "Output": ["o.id", "c.name"],
            "Plans": [{"Node Type": "Seq Scan", "Relation Name": "orders", "Schema": "public", "Alias": "o",
                       "Scan Direction": "Forward", "Startup Cost": 0, "Total Cost": 5, "Plan Rows": 1000, "Plan Width": 8,
                       "Shared Hit Blocks": 3, "Shared Read Blocks": 0}]},
            "Planning Time": 0.1, "Execution Time": 2.7}]"#;
        let r = parse_explain(json, true).unwrap();
        assert_eq!(r.plan.node_type, "Hash Join");
        assert_eq!(r.plan.qualifier.as_deref(), Some("Inner"));
        assert_eq!(r.plan.actual_rows, Some(90.0));
        assert_eq!(r.plan.details, vec![
            PlanDetail { key: "Hash Cond".into(), value: "(o.customer_id = c.id)".into() },
            PlanDetail { key: "Output".into(), value: "o.id, c.name".into() },
        ]);
        let scan = &r.plan.children[0];
        assert_eq!(scan.relation.as_deref(), Some("public.orders o"));
        assert_eq!(scan.qualifier, None);
        assert_eq!(scan.shared_hit_blocks, Some(3.0));
        assert_eq!(scan.actual_rows, None);
        assert_eq!(r.execution_time_ms, Some(2.7));
    }

    #[test]
    fn rejects_unexpected_shape() {
        assert!(parse_explain("{}", false).is_err());
        assert!(parse_explain("not json", false).is_err());
    }
}
