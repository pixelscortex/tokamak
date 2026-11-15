use super::*;

impl WebHost {
    pub(super) fn fetch_sync(&self, r: &mut Resources, p: &Json) -> Result<Json> {
        match text(p, "op")? {
            "open" => {
                let mut url = Url::parse(text(&p, "url")?).map_err(|e| e.to_string())?;
                self.permit(&mut url)?;
                r.capacity()?;
                let id = r.id();
                let (upload, receiver) = if p["stream"].as_bool() == Some(true) {
                    let (s, r) = mpsc::channel(1);
                    (Some(s), Some(r))
                } else {
                    (None, None)
                };
                r.requests.insert(
                    id,
                    Exchange {
                        cancel: CancellationToken::new(),
                        upload,
                        receiver,
                        response: Arc::default(),
                        remainder: Vec::new(),
                    },
                );
                Ok(json!(id))
            }
            "cancel" => {
                if let Some(x) = r.requests.remove(&id(&p)?) {
                    x.cancel.cancel();
                    if let Ok(mut response) = x.response.try_lock() {
                        response.take();
                    }
                }
                Ok(Json::Null)
            }
            "finish" => {
                if let Some(x) = r.requests.get_mut(&id(&p)?) {
                    x.upload.take();
                }
                Ok(Json::Null)
            }
            _ => unreachable!("dispatched web operation"),
        }
    }

    pub(super) async fn io(&self, p: Json) -> Result<Json> {
        let operation = text(&p, "op")?;
        let request_id = id(&p)?;
        if operation == "sleep" {
            return self.sleep(&p, request_id).await;
        }
        let (cancel, response) = {
            let r = self.resources.lock().map_err(|_| "web resource lock poisoned")?;
            let x = r.requests.get(&request_id).ok_or("fetch is aborted or closed")?;
            (x.cancel.clone(), x.response.clone())
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("fetch aborted".into()),
            result = async {
                match operation {
                    "send" => self.send(&p, request_id, response).await,
                    "write" => self.write(&p, request_id).await,
                    "read" => self.read(request_id, response).await,
                    _ => Err("unsupported async web operation".into()),
                }
            } => result
        };
        if result.is_err() {
            // A transport/read/upload failure is terminal even if JS catches it
            // or stops polling the corresponding promise.
            if let Some(exchange) = self
                .resources
                .lock()
                .map_err(|_| "web resource lock poisoned")?
                .requests
                .remove(&request_id)
            {
                exchange.cancel.cancel();
                if let Ok(mut response) = exchange.response.try_lock() {
                    response.take();
                }
            }
        }
        result
    }
    async fn send(
        &self,
        p: &Json,
        request_id: u64,
        response: Arc<AsyncMutex<Option<reqwest::Response>>>,
    ) -> Result<Json> {
        let mut url = Url::parse(text(&p, "url")?).map_err(|e| e.to_string())?;
        self.permit(&mut url)?;
        let method = reqwest::Method::from_bytes(text(&p, "method")?.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut request = self.client.request(method, url);
        for pair in p["headers"].as_array().ok_or("invalid headers")? {
            request = request.header(
                pair[0].as_str().ok_or("invalid header name")?,
                pair[1].as_str().ok_or("invalid header value")?,
            );
        }
        let receiver = self
            .resources
            .lock()
            .map_err(|_| "web resource lock poisoned")?
            .requests
            .get_mut(&request_id)
            .ok_or("fetch aborted")?
            .receiver
            .take();
        if let Some(receiver) = receiver {
            let stream = futures_util::stream::unfold(receiver, |mut receiver| async {
                receiver.recv().await.map(|b| (Ok::<_, std::io::Error>(b), receiver))
            });
            request = request.body(reqwest::Body::wrap_stream(stream));
        }
        let res = request.send().await.map_err(fetch_error)?;
        let headers: Vec<_> = res
            .headers()
            .iter()
            .map(|(k, v)| {
                vec![k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()]
            })
            .collect();
        let result = json!({"status":res.status().as_u16(),"statusText":res.status().canonical_reason().unwrap_or(""),"headers":headers,"url":res.url().as_str()});
        *response.lock().await = Some(res);
        Ok(result)
    }
    async fn write(&self, p: &Json, request_id: u64) -> Result<Json> {
        let sender = self
            .resources
            .lock()
            .map_err(|_| "web resource lock poisoned")?
            .requests
            .get(&request_id)
            .and_then(|x| x.upload.clone())
            .ok_or("request body is closed")?;
        sender.send(bytes(&p["bytes"])?).await.map_err(|_| "request body receiver closed")?;
        Ok(Json::Null)
    }
    async fn read(
        &self,
        request_id: u64,
        response: Arc<AsyncMutex<Option<reqwest::Response>>>,
    ) -> Result<Json> {
        let remainder = {
            let mut r = self.resources.lock().map_err(|_| "web resource lock poisoned")?;
            std::mem::take(&mut r.requests.get_mut(&request_id).ok_or("fetch aborted")?.remainder)
        };
        let mut data = if remainder.is_empty() {
            let mut guard = response.lock().await;
            let res = guard.as_mut().ok_or("response is closed")?;
            match res.chunk().await.map_err(|e| e.to_string())? {
                Some(chunk) => chunk.to_vec(),
                None => {
                    guard.take();
                    self.resources
                        .lock()
                        .map_err(|_| "web resource lock poisoned")?
                        .requests
                        .remove(&request_id);
                    return Ok(Json::Null);
                }
            }
        } else {
            remainder
        };
        if data.len() > CHUNK {
            let tail = data.split_off(CHUNK);
            if let Some(x) = self
                .resources
                .lock()
                .map_err(|_| "web resource lock poisoned")?
                .requests
                .get_mut(&request_id)
            {
                x.remainder = tail;
            }
        }
        Ok(json!(data))
    }
}

// reqwest's Display omits DNS causes. Keep the chain so JS receives the
// resolver's timeout/permission diagnostic instead of only a request URL.
fn fetch_error(error: reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut cause = std::error::Error::source(&error);
    while let Some(error) = cause {
        message.push_str(": ");
        message.push_str(&error.to_string());
        cause = error.source();
    }
    message
}
