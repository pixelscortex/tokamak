use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    rc::Rc,
    time::Duration,
};

use rquickjs::{Ctx, Exception, Promise, prelude::Func};
use tokio::sync::{Notify, oneshot};

#[derive(Clone, Default)]
pub struct Immediates {
    queue: Rc<RefCell<BTreeMap<u32, oneshot::Sender<()>>>>,
    scheduled: Rc<Notify>,
}

impl Immediates {
    fn schedule(&self, id: u32) -> oneshot::Receiver<()> {
        let (wake, fired) = oneshot::channel();
        self.queue.borrow_mut().insert(id, wake);
        self.scheduled.notify_one();
        fired
    }

    pub fn pending(&self) -> bool {
        !self.queue.borrow().is_empty()
    }

    pub async fn ready(&self) {
        while !self.pending() {
            self.scheduled.notified().await;
        }
    }

    pub fn fire(&self) {
        for (_, wake) in std::mem::take(&mut *self.queue.borrow_mut()) {
            let _ = wake.send(());
        }
    }

    fn clear(&self, id: u32) {
        self.queue.borrow_mut().remove(&id);
    }
}

pub fn install<'js>(ctx: &Ctx<'js>, immediates: Immediates) -> rquickjs::Result<()> {
    let timers = Rc::new(RefCell::new(HashMap::new()));
    let active = timers.clone();
    let queue = immediates.clone();
    ctx.globals().set(
        "__schedule",
        Func::from(move |ctx: Ctx<'js>, id: u32, delay: u32| {
            if active.borrow().len() >= 4096 {
                return Err(Exception::throw_message(
                    &ctx,
                    "QuickJS timer capacity exceeded (4096 live timers)",
                ));
            }
            let (promise, resolve, _) = Promise::new(&ctx)?;
            let (cancel, cancelled) = oneshot::channel::<()>();
            active.borrow_mut().insert(id, cancel);
            let active = active.clone();
            // Zero is reserved for the scheduler phase, never a timer.
            let immediate = (delay == 0).then(|| queue.schedule(id));
            ctx.spawn(async move {
                let fired = tokio::select! {
                    _ = cancelled => false,
                    fired = async {
                        if let Some(immediate) = immediate {
                            immediate.await.is_ok()
                        } else {
                            tokio::time::sleep(Duration::from_millis(delay.into())).await;
                            true
                        }
                    } => fired,
                };
                if fired {
                    active.borrow_mut().remove(&id);
                }
                let _ = resolve.call::<_, ()>((fired,));
            });
            Ok(promise)
        }),
    )?;
    ctx.globals().set(
        "__clear",
        Func::from(move |id: u32| {
            immediates.clear(id);
            timers.borrow_mut().remove(&id);
        }),
    )?;
    ctx.eval(include_str!("timers.js"))
}
