use super::*;
use crate::{actions::HttpCalls, http_actions::Route};

impl Server {
    pub(crate) async fn http_action(
        &self,
        plugin: String,
        path: String,
    ) -> Result<Option<(Route, HttpCalls)>, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::HttpAction(plugin, path, reply))?;
        wait.await.map_err(|_| Error::Closed)
    }
}

impl Coordinator {
    pub(super) fn reply_http_route(
        &self,
        id: &str,
        path: &str,
        reply: oneshot::Sender<Option<(Route, HttpCalls)>>,
    ) {
        let route = self.plugins.as_ref().and_then(|loaded| {
            let route = loaded.catalog.plugins.get(id)?.http_action(path)?;
            Some((
                route,
                HttpCalls {
                    generation: loaded.clone(),
                    owner: id.into(),
                    commands: self.commands.clone(),
                    runner: self.runner.clone(),
                    process: self.action_process().ok().cloned(),
                },
            ))
        });
        let _ = reply.send(route);
    }
}
