use crate::{Error, Json, OpRegistry};
use argon2::{
    Algorithm, Argon2, Params, Version,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};

/// Native Argon2id operations for action hosts. Passwords are UTF-8 and hashes
/// are salted PHC strings. Queries and mutations cannot call these operations.
pub fn register_password_crypto(ops: &mut OpRegistry) -> Result<(), Error> {
    ops.register_sync("crypto.hashPassword", |args| {
        hash_password(password(&args)?).map(Json::String)
    })?;
    ops.register_sync("crypto.verifyPassword", |args| {
        Ok(Json::Bool(
            verify(password(&args)?, encoded(&args)?).is_some(),
        ))
    })?;
    ops.register_sync("crypto.verifyAndRehashPassword", |args| {
        let password = password(&args)?;
        match verify(password, encoded(&args)?) {
            None => Ok(serde_json::json!({"valid": false})),
            Some(true) => Ok(serde_json::json!({"valid": true})),
            Some(false) => Ok(serde_json::json!({
                "valid": true, "replacementHash": hash_password(password)?
            })),
        }
    })
}

fn hash_password(password: &[u8]) -> Result<String, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Cannot generate a password salt")?;
    let salt = SaltString::encode_b64(&random).map_err(|_| "Cannot encode the password salt")?;
    Argon2::default()
        .hash_password(password, &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| "Cannot hash the password".into())
}

// Return whether a successfully verified hash already meets today's defaults.
fn verify(password: &[u8], encoded: &str) -> Option<bool> {
    let hash = PasswordHash::new(encoded).ok()?;
    let params = Params::try_from(&hash).ok()?;
    // Allow older settings, but bound memory and total work before verification.
    let max_work = (96 * 1024).max(Params::DEFAULT_M_COST.saturating_mul(Params::DEFAULT_T_COST));
    if hash.algorithm != Algorithm::Argon2id.ident()
        || !matches!(hash.version, Some(16 | 19))
        || params.m_cost() > (64 * 1024).max(Params::DEFAULT_M_COST)
        || params.m_cost().saturating_mul(params.t_cost()) > max_work
        || params.t_cost() > 8.max(Params::DEFAULT_T_COST)
        || params.p_cost() > 4.max(Params::DEFAULT_P_COST)
    {
        return None;
    }
    Argon2::default().verify_password(password, &hash).ok()?;
    Some(
        hash.version == Some(Version::V0x13.into())
            && params.m_cost() == Params::DEFAULT_M_COST
            && params.t_cost() == Params::DEFAULT_T_COST
            && params.p_cost() == Params::DEFAULT_P_COST
            && params.output_len() == Some(Params::DEFAULT_OUTPUT_LEN),
    )
}

fn password(args: &Json) -> Result<&[u8], String> {
    args["password"]
        .as_str()
        .filter(|value| value.len() <= 1024)
        .map(str::as_bytes)
        .ok_or_else(|| "Expected a password of at most 1024 bytes".into())
}

fn encoded(args: &Json) -> Result<&str, String> {
    args["hash"]
        .as_str()
        .ok_or_else(|| "Expected a password hash".into())
}
