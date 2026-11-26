use super::{Adapter, AuthContext};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response, Sse, sse},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::convert::Infallible;

pub(super) fn failure(status: StatusCode, kind: &str) -> Response {
    answer(status, json!({"failed": true, "kind": kind, "data": null}))
}

pub(super) fn answer(status: StatusCode, body: Value) -> Response {
    (
        status,
        [
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

pub(super) fn account_result(result: Result<Value, String>) -> Response {
    match result {
        Ok(value) => answer(StatusCode::OK, value),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

pub(super) fn snapshots<T: Serialize + PartialEq + Send + 'static>(
    adapter: Adapter,
    caller: AuthContext,
    read: fn(&Adapter, &AuthContext) -> Option<T>,
) -> Response {
    let Ok(permit) = adapter.snapshot_streams.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    // Subscribe before the initial read so there is no gap in the live list.
    let changes = adapter.identities.device_updates();
    let stream = futures_util::stream::unfold(
        (adapter, caller, changes, None::<T>, permit),
        move |(adapter, caller, mut changes, previous, permit)| async move {
            loop {
                changes.borrow_and_update();
                let snapshot = read(&adapter, &caller)?;
                if previous.as_ref() != Some(&snapshot) {
                    let event = sse::Event::default().data(serde_json::to_string(&snapshot).ok()?);
                    return Some((
                        Ok::<_, Infallible>(event),
                        (adapter, caller, changes, Some(snapshot), permit),
                    ));
                }
                tokio::select! {
                    _ = adapter.stopping.cancelled() => return None,
                    result = changes.changed() => result.ok()?,
                }
            }
        },
    );
    (
        [("cache-control", "no-store"), ("x-accel-buffering", "no")],
        Sse::new(stream).keep_alive(sse::KeepAlive::default()),
    )
        .into_response()
}
