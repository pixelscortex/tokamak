use super::*;

pub(super) fn sync(r: &mut Resources, p: &Json) -> Result<Json> {
    match text(p, "op")? {
        "timer" => {
            r.capacity()?;

            let id = r.id();
            r.timers.insert(id, CancellationToken::new());

            Ok(json!(id))
        }
        "clearTimer" => {
            if let Some(cancel) = r.timers.remove(&id(p)?) {
                cancel.cancel();
            }

            Ok(Json::Null)
        }
        _ => unreachable!("dispatched web operation"),
    }
}

impl WebHost {
    pub(super) async fn sleep(&self, p: &Json, request_id: u64) -> Result<Json> {
        let cancel = self
            .resources
            .lock()
            .map_err(|_| "web resource lock poisoned")?
            .timers
            .get(&request_id)
            .cloned()
            .ok_or("timer is closed")?;

        let ms = p["ms"].as_u64().ok_or("invalid timer delay")?.min(2_147_483_647);

        let fired = tokio::select! { _ = tokio::time::sleep(Duration::from_millis(ms)) => true, _ = cancel.cancelled() => false };
        self.resources.lock().map_err(|_| "web resource lock poisoned")?.timers.remove(&request_id);

        Ok(json!(fired))
    }
}
