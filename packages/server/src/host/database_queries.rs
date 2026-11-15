use super::database_operations::{field, text};
use super::*;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexQuery {
    name: String,
    eq: Vec<IndexEquality>,
    range: Vec<IndexRange>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexEquality {
    field: String,
    value: Json,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexRange {
    field: String,
    operator: RangeOperator,
    value: Json,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum RangeOperator {
    Gt,
    Gte,
    Lt,
    Lte,
}

pub(super) async fn query(
    tx: &mut Transaction,
    reads: &mut ReadSet,
    space: &DataSpace,
    payload: &Json,
) -> data::Result<Json> {
    let table = space.table(&Table::new(text(payload, "table")?)?)?;

    let (clauses, record_dependency) = filters(payload, space)?;

    let order = match text(payload, "order")? {
        "asc" => Order::Asc,
        "desc" => Order::Desc,
        _ => return Err(data::Error::Invalid("order must be asc or desc")),
    };

    let limit = limit(payload)?;

    if let Some(index) = payload.get("index") {
        if !clauses.is_empty() {
            return Err(data::Error::Invalid(
                "indexed queries require an empty where array",
            ));
        }

        return indexed(tx, reads, space, &table, index, order, limit).await;
    }

    match record_dependency {
        Some(id) => reads.record(id),
        None => reads.filter(table.clone(), clauses.clone()),
    }

    let query = tx.query(&table).order(order);
    // SDK fields are arbitrary TOP-LEVEL JSON keys, not SQL paths. Native
    // query equality has a narrower identifier/value language. Scan the
    // same snapshot in storage order, then apply SDK JSON equality and
    // limit here, rather than interpreting dotted keys or SQL NONE/null.
    let rows = Box::pin(query.collect()).await?;

    let rows = rows
        .into_iter()
        .map(|doc| space.document(doc))
        .collect::<data::Result<Vec<_>>>()?;

    Ok(Json::Array(
        rows.into_iter()
            .filter(|doc| {
                clauses.iter().all(|(key, expected)| {
                    doc.get(key)
                        .is_some_and(|actual| json_equal(actual, expected))
                })
            })
            .take(limit)
            .collect(),
    ))
}

type Clauses = Vec<(String, Json)>;

fn filters(payload: &Json, space: &DataSpace) -> data::Result<(Clauses, Option<data::Id>)> {
    let mut clauses = Vec::new();

    let mut record_dependency = None;

    for clause in field(payload, "where")?
        .as_array()
        .ok_or(data::Error::Invalid("where must be an array"))?
    {
        let name = text(clause, "field")?.to_owned();

        if name.is_empty() {
            return Err(data::Error::Invalid("filter field must be nonempty"));
        }

        let mut value = field(clause, "value")?.clone();

        if name == "_id"
            && let Some(raw) = value.as_str()
        {
            match space.id(raw) {
                Ok(id) => {
                    value = space.present_id(&id)?.into();
                    record_dependency = Some(id);
                }

                Err(data::Error::AccessDenied) => {
                    return Err(data::Error::AccessDenied);
                }

                Err(_) => {} // Invalid ID equality is an empty read, not a SQL expression.
            }
        }
        clauses.push((name, value));
    }

    Ok((clauses, record_dependency))
}

fn limit(payload: &Json) -> data::Result<usize> {
    let limit = field(payload, "limit")?;

    let limit = if limit.is_null() {
        usize::MAX
    } else {
        let count = limit
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(data::Error::Invalid(
                "limit must be a nonnegative safe integer or null",
            ))?;
        usize::try_from(count).unwrap_or(usize::MAX)
    };

    Ok(limit)
}

async fn indexed(
    tx: &mut Transaction,
    reads: &mut ReadSet,
    space: &DataSpace,
    table: &Table,
    index: &Json,
    order: Order,
    limit: usize,
) -> data::Result<Json> {
    // Deserialize strictly before execution; the core validates index
    // existence, ordered leading equalities and the next-field range,
    // even for limit zero. It also poisons failed transactions.
    let index: IndexQuery = serde_json::from_value(index.clone()).map_err(|_| {
        data::Error::Invalid("index must contain name, eq and range arrays with valid clauses")
    })?;
    // Range-aware dependencies can be added later. A whole-table read
    // correctly invalidates empty, bounded and limited index scans.
    reads.table(table.clone());

    let mut query = tx.query(table).with_index(&index.name).order(order);

    for clause in index.eq {
        query = query.eq(clause.field, clause.value);
    }

    for clause in index.range {
        query = match clause.operator {
            RangeOperator::Gt => query.gt(clause.field, clause.value),
            RangeOperator::Gte => query.gte(clause.field, clause.value),
            RangeOperator::Lt => query.lt(clause.field, clause.value),
            RangeOperator::Lte => query.lte(clause.field, clause.value),
        };
    }

    let rows = Box::pin(query.limit(limit.min(u32::MAX as usize) as u32).collect()).await?;

    Ok(Json::Array(
        rows.into_iter()
            .map(|doc| space.document(doc))
            .collect::<data::Result<Vec<_>>>()?,
    ))
}
