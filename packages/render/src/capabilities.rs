//! Small window-owned host capabilities unavailable in QuickJS.
use crate::{Error, HostSender, Result};
use engine::rquickjs::{Ctx, Exception, Function};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

pub(crate) type Host = Rc<RefCell<Option<HostSender>>>;

pub(crate) fn install(ctx: &Ctx<'_>, host: Host) -> Result<()> {
    let install = || -> engine::rquickjs::Result<()> {
        let (writes, requests) = mpsc::sync_channel::<(HostSender, u32, String)>(32);
        std::thread::Builder::new()
            .name("ui-clipboard".into())
            .spawn(move || {
                write_clipboard(requests);
            })
            .map_err(|error| Exception::throw_message(ctx, &error.to_string()))?;

        // Plugin UIs are trusted local code in this version and may write,
        // but never read, the clipboard. A permission gate will be added when
        // third-party plugins are supported.
        let clipboard_host = host.clone();
        ctx.globals().set(
            "__tokamakClipboard",
            Function::new(ctx.clone(), move |ctx: Ctx<'_>, id: u32, text: String| {
                let sender = clipboard_host
                    .borrow()
                    .clone()
                    .ok_or_else(|| Exception::throw_message(&ctx, "No window mailbox"))?;
                writes
                    .try_send((sender, id, text))
                    .map_err(|error| Exception::throw_message(&ctx, &error.to_string()))
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

fn write_clipboard(requests: mpsc::Receiver<(HostSender, u32, String)>) {
    let mut clipboard = None;
    for (sender, id, text) in requests {
        let result = (|| {
            if clipboard.is_none() {
                clipboard = Some(arboard::Clipboard::new()?);
            }
            match clipboard.as_mut() {
                Some(clipboard) => clipboard.set_text(text),
                None => Err(arboard::Error::ClipboardNotSupported),
            }
        })();
        let error = result.err().map(|error| error.to_string());
        let _ = sender.send(
            "tk:clipboard",
            serde_json::json!({ "id": id, "error": error }),
        );
    }
}
