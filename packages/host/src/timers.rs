use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Duration};

use rquickjs::{Ctx, Exception, Promise, prelude::Func};

pub fn install<'js>(ctx: &Ctx<'js>) -> rquickjs::Result<()> {
    let timers = Rc::new(RefCell::new(HashMap::new()));
    let active = timers.clone();
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
            let (cancel, cancelled) = tokio::sync::oneshot::channel::<()>();
            active.borrow_mut().insert(id, cancel);
            let active = active.clone();
            ctx.spawn(async move {
                let fired = tokio::select! {
                    _ = cancelled => false,
                    () = tokio::time::sleep(Duration::from_millis(delay.into())) => true,
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
            timers.borrow_mut().remove(&id);
        }),
    )?;
    ctx.eval(include_str!("timers.js"))
}
