use super::*;
use crate::http_actions::Route;

impl Server {
    pub(crate) async fn http_action(
        &self,
        plugin: String,
        path: String,
    ) -> Result<Option<Route>, Error> {
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
        reply: oneshot::Sender<Option<Route>>,
    ) {
        let route = self
            .plugins
            .as_ref()
            .and_then(|loaded| loaded.catalog.plugins.get(id))
            .and_then(|plugin| plugin.http_action(path));
        let _ = reply.send(route);
    }
}
