//! Small window-owned host capabilities unavailable in QuickJS.
use crate::{Error, HostSender, Result};
use engine::rquickjs::{Ctx, Exception, Function};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

pub(crate) type Host = Rc<RefCell<Option<HostSender>>>;

pub(crate) fn install(ctx: &Ctx<'_>, host: Host) -> Result<()> {
    let install = || -> engine::rquickjs::Result<()> {
        let clipboard = RefCell::new(None::<arboard::Clipboard>);
        ctx.globals().set(
            "__tokamakClipboard",
            Function::new(ctx.clone(), move |ctx: Ctx<'_>, text: String| {
                let mut clipboard = clipboard.borrow_mut();
                let result = (|| {
                    if clipboard.is_none() {
                        *clipboard = Some(arboard::Clipboard::new()?);
                    }
                    clipboard.as_mut().unwrap().set_text(text)
                })();
                result.map_err(|error| Exception::throw_message(&ctx, &error.to_string()))
            })?,
        )?;

        let pending = Arc::new(AtomicUsize::new(0));
        ctx.globals().set(
            "__tokamakAfter",
            Function::new(ctx.clone(), move |ctx: Ctx<'_>, id: u32, ms: u32| {
                let sender = host
                    .borrow()
                    .clone()
                    .ok_or_else(|| Exception::throw_message(&ctx, "No window mailbox"))?;
                if ms > 60_000 || pending.load(Ordering::Acquire) >= 32 {
                    return Err(Exception::throw_message(
                        &ctx,
                        "Too many or too long UI delays",
                    ));
                }
                pending.fetch_add(1, Ordering::AcqRel);
                let outstanding = pending.clone();
                let result = std::thread::Builder::new()
                    .name("ui-delay".into())
                    .spawn(move || {
                        std::thread::sleep(Duration::from_millis(ms.into()));
                        let _ = sender.send("tk:delay", id);
                        outstanding.fetch_sub(1, Ordering::AcqRel);
                    });
                if let Err(error) = result {
                    pending.fetch_sub(1, Ordering::AcqRel);
                    return Err(Exception::throw_message(&ctx, &error.to_string()));
                }
                Ok(())
            })?,
        )?;
        Ok(())
    };
    install().map_err(|error| Error(error.to_string()))
}
