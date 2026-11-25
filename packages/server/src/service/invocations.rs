use super::*;

impl Coordinator {
    pub(super) async fn invoke_function(
        &mut self,
        name: &str,
        args: Json,
        mutation: bool,
        auth: Option<crate::identity::AuthContext>,
    ) -> Result<Json, CallError> {
        self.invoke_function_in(self.plugins.clone(), name, args, mutation, auth.into())
            .await
    }

    pub(super) async fn invoke_function_in(
        &mut self,
        plugins: Option<Arc<crate::plugins::Loaded>>,
        name: &str,
        args: Json,
        mutation: bool,
        note: crate::identity::CallNote,
    ) -> Result<Json, CallError> {
        let mut result = Err("mutation conflict retry limit exceeded".into());

        let determinism = engine::Determinism::default();

        for attempt in 0..ATTEMPTS {
            let note = if mutation {
                note.mutation_attempt()
            } else {
                note.clone()
            };
            let call = host::invoke(
                &self.database,
                &self.pool,
                host::Invocation {
                    bundle: self.bundle.clone(),
                    name,
                    args: args.clone(),
                    mutation,
                    space: &self.space,
                    plugins: plugins.clone(),
                    determinism,
                    note: note.clone(),
                },
            )
            .await;

            if mutation && call.conflict {
                note.retry_hooks();
                if attempt + 1 == ATTEMPTS {
                    break;
                }

                continue; // Replay the entire handler in a fresh transaction and JS world.
            }

            result = call.result;
            break;
        }

        result
    }
}
