use super::{
    response::{answer, failure},
    sign_in_limit::{Attempt, Rejection},
    *,
};
use crate::{plugins::SignInMethod, service::SignInError};
use axum::extract::{ConnectInfo, DefaultBodyLimit};
use serde::Deserialize;
use serde_json::json;
use std::{collections::BTreeMap, net::IpAddr, time::Instant};

pub(super) const METHODS: &str = "/auth/methods";
pub(super) const SIGN_IN: &str = "/auth/sign-in";
pub(super) const OWNER_KEY: &str = "/auth/owner";
pub(super) const OWNER_SETUP: &str = "/auth/owner/setup";

pub(super) struct SetupLease {
    device: String,
    expires: Instant,
}

pub(super) fn routes() -> Router<Adapter> {
    Router::new()
        .route(METHODS, get(methods))
        .route(SIGN_IN, post(sign_in))
        .route(OWNER_KEY, post(owner_key))
        .route(OWNER_SETUP, post(setup_owner))
        .route(
            "/members/{id}/devices",
            post(|| async { StatusCode::NOT_FOUND }),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}

async fn methods(State(adapter): State<Adapter>) -> Response {
    let Ok(methods) = adapter.server.sign_in_methods().await else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable");
    };
    let owner_setup = adapter.identities.owner_needs_setup()
        && methods
            .iter()
            .any(|method| method.setup_owner_form.is_some());
    answer(
        StatusCode::OK,
        json!({"methods": methods, "ownerSetup": owner_setup}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerKeyInput {
    device_name: String,
    #[serde(default)]
    setup: bool,
}

async fn owner_key(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
    body: String,
) -> Response {
    if !adapter.identities.is_bootstrap(&caller) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(input) = serde_json::from_str::<OwnerKeyInput>(&body) else {
        return failure(StatusCode::BAD_REQUEST, "InvalidFields");
    };
    let Ok(device_name) = crate::identity::name(&input.device_name) else {
        return failure(StatusCode::BAD_REQUEST, "InvalidDeviceName");
    };
    // A broken or absent provider cannot prevent recovery.
    let methods = if input.setup && adapter.identities.owner_needs_setup() {
        adapter.server.sign_in_methods().await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut setup: Vec<SignInMethod> = methods
        .into_iter()
        .filter(|method| method.setup_owner_form.is_some())
        .collect();
    let Ok((device, key)) = adapter
        .identities
        .issue_device(&caller.user.id, &device_name)
    else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable");
    };
    if !setup.is_empty() {
        if let Ok(mut lease) = adapter.owner_setup.try_lock() {
            *lease = Some(SetupLease {
                device: device.id.clone(),
                expires: Instant::now() + Duration::from_secs(600),
            });
        } else {
            setup.clear(); // Setup is already running; the recovery device still works.
        }
    }
    audit_device(&caller.user.id, &device.id);
    answer(
        StatusCode::OK,
        json!({"device": device, "key": key, "setupMethods": setup}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignInInput {
    method: String,
    fields: BTreeMap<String, String>,
    device_name: String,
    new_password: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupInput {
    method: String,
    fields: BTreeMap<String, String>,
}

async fn sign_in(
    State(adapter): State<Adapter>,
    ConnectInfo(PeerAddr(peer)): ConnectInfo<PeerAddr>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let Ok(input) = serde_json::from_str::<SignInInput>(&body) else {
        return failure(StatusCode::BAD_REQUEST, "InvalidFields");
    };
    let Ok(device_name) = crate::identity::name(&input.device_name) else {
        return failure(StatusCode::BAD_REQUEST, "InvalidDeviceName");
    };
    let address = sign_in_address(peer.ip(), &adapter.trusted_sign_in_proxies, &headers);
    let mut attempt = match Attempt::begin(adapter.sign_in_limit.clone(), address) {
        Ok(attempt) => attempt,
        Err(error) => return throttle(error),
    };
    let Ok(methods) = adapter.server.sign_in_methods().await else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable");
    };
    let Some(method) = methods.into_iter().find(|method| method.id == input.method) else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable");
    };
    if let Some(login) = method
        .login_field
        .as_ref()
        .and_then(|field| input.fields.get(field))
        && let Err(error) = attempt.for_login(&method.id, login)
    {
        return throttle(error);
    }
    // An abandoned HTTP request still owns its slot until the provider finishes.
    tokio::spawn(async move {
        let _credentials = adapter.credentials.read().await;
        let fields = json!(input.fields);
        let account = match adapter
            .server
            .run_sign_in(input.method, fields.clone())
            .await
        {
            Ok(account) => account,
            Err(error) => {
                if matches!(error, SignInError::Denied(_) | SignInError::Unavailable) {
                    attempt.rejected();
                }
                return action_failure(error);
            }
        };
        let Some(member) = adapter.identities.account_member(&account.binding) else {
            attempt.rejected();
            return failure(StatusCode::UNAUTHORIZED, "AccountNotLinked");
        };
        if account.password_change_required {
            let Some(password) = input.new_password else {
                attempt.accepted();
                // No key or restricted workspace session exists until replacement succeeds.
                return failure(StatusCode::FORBIDDEN, "PasswordChangeRequired");
            };
            if let Err(error) = adapter
                .server
                .change_temporary_password(account.binding, fields, password)
                .await
            {
                return action_failure(error);
            }
        } else if input.new_password.is_some() {
            return failure(StatusCode::BAD_REQUEST, "PasswordChangeNotRequired");
        }
        attempt.accepted();
        issue(&adapter, &member, &device_name)
    })
    .await
    .unwrap_or_else(|_| failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable"))
}

fn sign_in_address(peer: IpAddr, trusted_proxies: &[IpAddr], headers: &HeaderMap) -> IpAddr {
    let mut address = peer.to_canonical();
    // Walk back only across configured hops. Values preceding the first
    // untrusted peer could have been supplied by that peer.
    for value in headers.get_all("x-forwarded-for").iter().rev() {
        let Ok(value) = value.to_str() else {
            break;
        };
        for hop in value.rsplit(',') {
            if !trusted_proxies.contains(&address) {
                return address;
            }
            let Ok(hop) = hop.trim().parse::<IpAddr>() else {
                return address;
            };
            address = hop.to_canonical();
        }
    }
    address
}

async fn setup_owner(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
    body: String,
) -> Response {
    let Ok(input) = serde_json::from_str::<SetupInput>(&body) else {
        return failure(StatusCode::BAD_REQUEST, "InvalidFields");
    };
    // Complete both writes even if the browser disconnects mid-setup.
    tokio::spawn(async move {
        let Ok(mut lease) = adapter.owner_setup.try_lock() else {
            return failure(StatusCode::CONFLICT, "OwnerSetupInProgress");
        };
        if !lease
            .as_ref()
            .is_some_and(|lease| caller.device.id == lease.device && Instant::now() < lease.expires)
        {
            return failure(StatusCode::FORBIDDEN, "OwnerSetupExpired");
        }
        if !adapter.identities.owner_needs_setup() {
            return failure(StatusCode::CONFLICT, "OwnerAlreadySetUp");
        }
        let account = match adapter
            .server
            .create_owner_account(input.method, json!(input.fields))
            .await
        {
            Ok(account) => account,
            Err(error) => return action_failure(error),
        };
        match adapter
            .update_user(|| {
                adapter
                    .identities
                    .bind_owner_account(account.binding, account.display_name.as_deref())
            })
            .await
        {
            Ok(_) => {
                *lease = None;
                StatusCode::NO_CONTENT.into_response()
            }
            Err(_) => failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable"),
        }
    })
    .await
    .unwrap_or_else(|_| failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable"))
}

fn issue(adapter: &Adapter, member: &str, device_name: &str) -> Response {
    match adapter.identities.issue_device(member, device_name) {
        Ok((device, key)) => {
            audit_device(member, &device.id);
            answer(StatusCode::OK, json!({"device": device, "key": key}))
        }
        Err(_) => failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable"),
    }
}

fn audit_device(member: &str, device: &str) {
    eprintln!("Device key issued: member={member:?} device={device:?}");
}

fn throttle(rejection: Rejection) -> Response {
    match rejection {
        Rejection::Busy => failure(StatusCode::TOO_MANY_REQUESTS, "SignInBusy"),
        Rejection::Backoff(delay) => {
            let mut response = failure(StatusCode::TOO_MANY_REQUESTS, "SignInThrottled");
            let retry = delay.as_secs() + u64::from(delay.subsec_nanos() > 0);
            response.headers_mut().insert("retry-after", retry.into());
            response.headers_mut().insert(
                "access-control-expose-headers",
                axum::http::HeaderValue::from_static("Retry-After"),
            );
            response
        }
    }
}

fn action_failure(error: SignInError) -> Response {
    match error {
        SignInError::Denied(kind) => failure(StatusCode::UNAUTHORIZED, &kind),
        SignInError::InvalidFields => failure(StatusCode::BAD_REQUEST, "InvalidFields"),
        SignInError::Busy => failure(StatusCode::TOO_MANY_REQUESTS, "SignInBusy"),
        SignInError::Unavailable => failure(StatusCode::SERVICE_UNAVAILABLE, "SignInUnavailable"),
    }
}
