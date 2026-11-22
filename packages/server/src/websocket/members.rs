use super::response::{answer, failure};
use super::*;
use axum::extract::DefaultBodyLimit;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

pub(super) const MEMBERS: &str = "/members";
pub(super) const LIVE: &str = "/members/live";
pub(super) const ROLE: &str = "/members/{id}/role";
pub(super) const REVOKE: &str = "/members/{id}/revoke";
pub(super) const RESET: &str = "/members/{id}/reset-password";

pub(super) fn matches_path(path: Option<&str>) -> bool {
    matches!(path, Some(MEMBERS | LIVE | ROLE | REVOKE | RESET))
}

pub(super) fn routes() -> Router<Adapter> {
    Router::new()
        .route(MEMBERS, get(list).post(add))
        .route(LIVE, get(live))
        .route(ROLE, post(set_role))
        .route(REVOKE, post(revoke))
        .route(RESET, post(reset))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

pub(super) fn can_manage(role: Role) -> bool {
    matches!(role, Role::Owner | Role::Admin)
}

async fn list(State(adapter): State<Adapter>) -> Response {
    answer(StatusCode::OK, adapter.identities.list())
}

#[derive(Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MemberRow {
    #[serde(flatten)]
    user: User,
    has_account: bool,
}

#[derive(Serialize, PartialEq, Eq)]
struct Snapshot {
    viewer: User,
    members: Vec<MemberRow>,
}

async fn live(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
) -> Response {
    snapshots(adapter, caller, |identities, caller| {
        let (current, _) = identities.active_caller(caller)?;
        can_manage(current.user.role).then(|| Snapshot {
            viewer: current.user,
            members: identities
                .active_members()
                .into_iter()
                .map(|(user, has_account)| MemberRow { user, has_account })
                .collect(),
        })
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountInput {
    method: String,
    fields: BTreeMap<String, String>,
}

async fn add(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
    body: String,
) -> Response {
    // Finish the provider write, binding and notification even if the client leaves.
    tokio::spawn(async move {
        let Ok(_edit) = adapter.member_edits.try_lock() else {
            return busy();
        };
        if current_role(&adapter, &caller).is_none() {
            return StatusCode::FORBIDDEN.into_response();
        }
        let Ok(input) = serde_json::from_str::<AccountInput>(&body) else {
            return invalid_fields();
        };
        match adapter
            .server
            .create_member_account(&adapter.identities, input.method, json!(input.fields))
            .await
        {
            Ok(user) => answer(StatusCode::OK, json!(user)),
            Err(error) => provider_failure(error),
        }
    })
    .await
    .unwrap_or_else(|_| unavailable())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetInput {
    password: String,
}

async fn reset(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
    Path(id): Path<String>,
    body: String,
) -> Response {
    let Ok(input) = serde_json::from_str::<ResetInput>(&body) else {
        return invalid_fields();
    };
    tokio::spawn(async move {
        let Ok(_edit) = adapter.member_edits.try_lock() else {
            return busy();
        };
        if !can_change_target(&adapter, &caller, &id) {
            return StatusCode::FORBIDDEN.into_response();
        }
        let Some(binding) = adapter.identities.member_account(&id) else {
            return failure(StatusCode::CONFLICT, "AccountNotLinked");
        };
        let _credentials = adapter.credentials.write().await;
        match adapter
            .server
            .reset_member_password(binding, input.password)
            .await
        {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => provider_failure(error),
        }
    })
    .await
    .unwrap_or_else(|_| unavailable())
}

async fn revoke(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
    Path(id): Path<String>,
) -> Response {
    let Ok(_edit) = adapter.member_edits.try_lock() else {
        return busy();
    };
    // Owners can retry cleanup of an already revoked member; the identity store still protects the owner.
    if current_role(&adapter, &caller) != Some(Role::Owner)
        && !can_change_target(&adapter, &caller, &id)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    account_result(
        adapter
            .server
            .revoke_member(&adapter.identities, id.clone())
            .await
            .map(|()| json!({"revoked": id})),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleInput {
    role: Role,
}

async fn set_role(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
    Path(id): Path<String>,
    body: String,
) -> Response {
    let Ok(input) = serde_json::from_str::<RoleInput>(&body) else {
        return invalid_fields();
    };
    let Ok(_edit) = adapter.member_edits.try_lock() else {
        return busy();
    };
    if current_role(&adapter, &caller) != Some(Role::Owner) {
        return StatusCode::FORBIDDEN.into_response();
    }
    account_result(
        adapter
            .update_user(|| adapter.identities.set_role(&id, input.role))
            .await
            .map(|user| json!(user)),
    )
}

fn current_role(adapter: &Adapter, caller: &AuthContext) -> Option<Role> {
    let (current, _) = adapter.identities.active_caller(caller)?;
    can_manage(current.user.role).then_some(current.user.role)
}

fn can_change_target(adapter: &Adapter, caller: &AuthContext, id: &str) -> bool {
    let target = adapter.identities.active_member(id).map(|user| user.role);
    matches!(
        (current_role(adapter, caller), target),
        (Some(Role::Owner | Role::Admin), Some(Role::Member))
            | (Some(Role::Owner), Some(Role::Admin))
    )
}

fn invalid_fields() -> Response {
    failure(StatusCode::BAD_REQUEST, "InvalidFields")
}

fn unavailable() -> Response {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "MemberManagementUnavailable",
    )
}

fn busy() -> Response {
    failure(StatusCode::CONFLICT, "MemberManagementBusy")
}

fn provider_failure(error: crate::service::SignInError) -> Response {
    use crate::service::SignInError;
    match error {
        SignInError::InvalidFields => invalid_fields(),
        SignInError::Busy => busy(),
        SignInError::Unavailable => unavailable(),
        SignInError::Denied(kind) => failure(StatusCode::BAD_REQUEST, &kind),
    }
}
