use super::{
    Caller, Operation,
    invite::{hash, now, random},
};
use crate::data::{DataSpace, Database, Error, Id, Result, Table, Transaction, json_object};
use serde_json::{Value as Json, json};
use subtle::ConstantTimeEq;

fn table(name: &str) -> Result<Table> {
    DataSpace::host().table(&Table::new(name)?)
}

fn keyed(name: &str, key: &str) -> Result<Id> {
    Id::new(table(name)?, key)
}

pub(super) async fn execute(database: &Database, operation: Operation) -> Result<Json> {
    let mut tx = Box::pin(database.begin()).await?;
    let result = Box::pin(apply(&mut tx, operation)).await;
    match result {
        Ok(value) => {
            Box::pin(tx.commit()).await?;
            Ok(value)
        }
        Err(error) => {
            Box::pin(tx.rollback()).await?;
            Err(error)
        }
    }
}

async fn apply(tx: &mut Transaction, operation: Operation) -> Result<Json> {
    match operation {
        Operation::Invite(options) => {
            options.validate()?;
            let code = random(16)?;
            let code_hash = hash(&code);
            let expires = now()? + options.ttl_seconds;
            tx.insert_keyed(
                &keyed("invites", &code_hash)?,
                json_object(&json!({
                    "codeHash":code_hash, "usesLeft":options.uses, "expiresAt":expires
                }))?,
            )
            .await?;
            Ok(json!({"link":options.link(&code)}))
        }
        Operation::Join { code, name } => {
            if name.is_empty() || name.chars().count() > 32 || name.chars().any(char::is_control) {
                return Err(Error::Invalid(
                    "Name must have 1–32 characters without controls",
                ));
            }
            if code.len() != 32 || !code.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(Error::AccessDenied);
            }
            let id = keyed("invites", &hash(&code))?;
            let invite = tx.get(&id).await?.ok_or(Error::AccessDenied)?.into_json();
            let uses = invite["usesLeft"].as_u64().ok_or(Error::AccessDenied)?;
            if uses == 0 || invite["expiresAt"].as_u64().ok_or(Error::AccessDenied)? <= now()? {
                return Err(Error::AccessDenied);
            }
            if uses == 1 {
                tx.delete(&id).await?;
            } else {
                tx.patch(&id, json_object(&json!({"usesLeft":uses - 1}))?)
                    .await?;
            }

            let member_id = random(16)?;
            let token = random(32)?;
            tx.insert_keyed(&keyed("members", &member_id)?, json_object(&json!({
                "memberId":member_id, "name":name, "role":"guest", "tokenHash":hash(&token), "createdAt":now()?
            }))?).await?;
            Ok(json!({"memberId":member_id,"token":token}))
        }
        Operation::List => {
            let rows = tx.query(&table("members")?).collect().await?;
            Ok(Json::Array(rows.into_iter().map(|row| {
                let row = row.into_json();
                json!({"memberId":row["memberId"],"name":row["name"],"role":row["role"],"createdAt":row["createdAt"]})
            }).collect()))
        }
        Operation::Revoke(id) => {
            tx.delete(&keyed("members", &id)?).await?;
            Ok(Json::Null)
        }
    }
}

pub(super) async fn authenticate(database: &Database, token: &str) -> Result<Caller> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::AccessDenied);
    }
    let mut tx = Box::pin(database.read_only()).await?;
    // Read members by their public record keys; never use the credential hash
    // as a database predicate (database string comparisons are not constant-time).
    let rows = Box::pin(tx.query(&table("members")?).collect()).await;
    Box::pin(tx.commit()).await?;
    let token_hash = hash(token);
    let mut member = None;
    for row in rows? {
        let row = row.into_json();
        let stored = row["tokenHash"].as_str().unwrap_or("");
        if bool::from(stored.as_bytes().ct_eq(token_hash.as_bytes())) {
            member = Some(row);
        }
    }
    let row = member.ok_or(Error::AccessDenied)?;
    Ok(Caller {
        member_id: row["memberId"].as_str().ok_or(Error::AccessDenied)?.into(),
        name: row["name"].as_str().ok_or(Error::AccessDenied)?.into(),
        role: "guest".into(),
    })
}
