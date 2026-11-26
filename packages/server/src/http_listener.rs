//! Drive Hyper directly so every HTTP/1 request has a header deadline.
//! Axum's convenience listener does not configure a Hyper timer.
use std::{io, time::Duration};

use axum::{Router, extract::ConnectInfo, serve::Listener};
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::websocket::{PeerAddr, ShutdownListener};

const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) async fn serve(
    mut listener: ShutdownListener,
    app: Router,
    stopping: CancellationToken,
) -> io::Result<()> {
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            () = stopping.cancelled() => break,
            Some(result) = tasks.join_next() => {
                if let Err(error) = result {
                    eprintln!("HTTP connection task failed: {error}");
                }
            },
            (socket, addr) = listener.accept() => {
                let service = TowerToHyperService::new(app.clone().layer(axum::Extension(ConnectInfo(PeerAddr(addr)))));
                tasks.spawn(async move {
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADER_TIMEOUT)
                        .serve_connection(TokioIo::new(socket), service)
                        .with_upgrades()
                        .await;
                });
            }
        }
    }
    while tasks.join_next().await.is_some() {}
    Ok(())
}
