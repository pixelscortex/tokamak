use super::*;

// This token only holds bookkeeping for a savepoint owned by the transaction.
// If a scoped call is dropped before it finishes, its ModuleCall error handler
// poisons the invocation and the owner rolls back the entire transaction.
#[must_use]
pub(crate) struct Savepoint {
    written: BTreeSet<Table>,
    changes: Option<Vec<RecordChange>>,
    change_bytes: usize,
}

impl Transaction {
    pub(crate) async fn savepoint(&mut self) -> Result<Savepoint> {
        let mutation = Mutation::new(self);
        let tx = &mut *mutation.tx;
        let result = async {
            tx.ready(true)?;
            tx.inner.new_save_point().await?;
            Ok(Savepoint {
                written: tx.written.clone(),
                changes: tx.changes.clone(),
                change_bytes: tx.change_bytes,
            })
        }
        .await;
        mutation.finish(result)
    }

    pub(crate) async fn finish_savepoint(&mut self, mark: Savepoint, rollback: bool) -> Result<()> {
        let mutation = Mutation::new(self);
        let tx = &mut *mutation.tx;
        let result = async {
            tx.ready(true)?;
            if rollback {
                tx.inner.rollback_to_save_point().await?;
                // Only writes that survive the savepoint may invalidate subscriptions.
                tx.written = mark.written;
                tx.changes = mark.changes;
                tx.change_bytes = mark.change_bytes;
            } else {
                tx.inner.release_last_save_point().await?;
            }
            Ok(())
        }
        .await;
        mutation.finish(result)
    }
}
