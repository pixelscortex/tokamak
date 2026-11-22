use super::Json;
use crate::identity::AuthContext;

pub(super) type BuiltinQuery = fn(&AuthContext) -> Json;

/// Resolve and validate once; the returned query reads the current caller on each run.
pub(super) fn resolve(name: &str, args: &Json) -> Option<Result<BuiltinQuery, &'static str>> {
    match name {
        "auth:caller" => Some(if args.as_object().is_some_and(|args| args.is_empty()) {
            Ok(|auth| serde_json::json!(auth))
        } else {
            Err("auth caller query requires empty arguments")
        }),
        _ => None,
    }
}
