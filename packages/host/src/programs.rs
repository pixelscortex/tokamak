mod lines;
mod process;

use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::{Arc, Mutex as RegistryLock},
};

use rquickjs::{
    Ctx, Exception, Function, Object, Result, TypedArray,
    prelude::{Async, Func},
};
use tokio::{io::AsyncRead, sync::Mutex};

use self::{lines::Lines, process::Program};

const PROGRAM_CAPACITY: usize = 256;

#[derive(Clone, Default)]
pub struct Programs(Arc<RegistryLock<Registry>>);

#[derive(Default)]
struct Registry {
    live: Vec<OwnedProgram>,
    sealed: HashSet<u64>,
}

struct OwnedProgram {
    call: u64,
    finish_on_cancel: bool,
    program: Arc<Program>,
}

impl Programs {
    pub fn stop_call(&self, call: u64) {
        for owned in self
            .0
            .lock()
            .expect("program registry")
            .live
            .iter()
            .filter(|owned| owned.call == call && !owned.finish_on_cancel)
        {
            owned.program.stop(false);
        }
    }

    pub fn kill_call(&self, call: u64) {
        let mut registry = self.0.lock().expect("program registry");
        registry.sealed.insert(call);
        for owned in registry.live.iter().filter(|owned| owned.call == call) {
            owned.program.stop(true);
        }
    }

    pub fn retire(&self, call: u64) {
        self.0
            .lock()
            .expect("program registry")
            .sealed
            .remove(&call);
    }

    pub fn stop_all(&self) {
        let mut registry = self.0.lock().expect("program registry");
        registry.sealed.clear();
        for owned in registry.live.drain(..) {
            owned.program.stop(true);
        }
    }

    pub fn factory<'js>(&self, ctx: &Ctx<'js>) -> Result<Function<'js>> {
        let programs = self.clone();
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, call: u64, argv: Vec<String>, options: Object<'js>| {
                programs.spawn(&ctx, call, &argv, options)
            },
        )
    }

    fn spawn<'js>(
        &self,
        ctx: &Ctx<'js>,
        call: u64,
        argv: &[String],
        options: Object<'js>,
    ) -> Result<Object<'js>> {
        let cwd = options.get::<_, Option<String>>("cwd")?;
        let env = options.get::<_, Option<HashMap<String, String>>>("env")?;
        let finish_on_cancel = options
            .get::<_, Option<bool>>("finishOnCancel")?
            .unwrap_or_default();
        let handle = Object::new_proto(ctx.clone(), None)?;
        let mut programs = self.0.lock().expect("program registry");
        if programs.sealed.contains(&call) {
            drop(programs);
            return Err(Exception::throw_message(
                ctx,
                "This invocation's programs were stopped",
            ));
        }
        programs.live.retain(|owned| !owned.program.finished());
        if programs.live.len() >= PROGRAM_CAPACITY {
            drop(programs);
            return Err(Exception::throw_message(
                ctx,
                "Plugin host program capacity exceeded (256 live programs)",
            ));
        }

        let (program, stdout, stderr) = match Program::spawn(argv, cwd, env) {
            Ok(program) => program,
            Err(error) => {
                drop(programs);
                handle.set("error", error.to_string())?;
                return Ok(handle);
            }
        };
        programs.live.push(OwnedProgram {
            call,
            finish_on_cancel,
            program: program.clone(),
        });
        drop(programs);

        // These closures are capabilities for this exact program. No plugin
        // receives the registry, a lookup operation or a program identifier.
        handle.set("stdout", reader(ctx, stdout, program.clone())?)?;
        handle.set("stderr", reader(ctx, stderr, program.clone())?)?;
        let running = program.clone();
        handle.set(
            "exit",
            Func::from(Async(move |ctx: Ctx<'js>| {
                let running = running.clone();
                async move {
                    running
                        .exited()
                        .await
                        .map_err(|error| Exception::throw_message(&ctx, &error))
                }
            })),
        )?;
        let running = program.clone();
        handle.set("stop", Func::from(move |force: bool| running.stop(force)))?;
        let running = program.clone();
        handle.set(
            "stopped",
            Func::from(Async(move || {
                let running = running.clone();
                async move { running.stopped().await }
            })),
        )?;
        let running = program.clone();
        handle.set(
            "write",
            Func::from(move |ctx: Ctx<'js>, bytes: TypedArray<'js, u8>| {
                // SAFETY: Copy before doing anything that could re-enter JS.
                let bytes = unsafe { bytes.as_bytes() }
                    .ok_or_else(|| Exception::throw_type(&ctx, "Expected a live byte array"))?;
                running
                    .write(bytes)
                    .map_err(|error| Exception::throw_message(&ctx, error))
            }),
        )?;
        handle.set("closeInput", Func::from(move || program.close_input()))?;
        Ok(handle)
    }
}

fn reader<'js>(
    ctx: &Ctx<'js>,
    pipe: impl AsyncRead + Unpin + Send + 'static,
    program: Arc<Program>,
) -> Result<Function<'js>> {
    let lines = Rc::new(Mutex::new(Lines::new(pipe)));
    Function::new(
        ctx.clone(),
        Async(move |ctx: Ctx<'js>| {
            let lines = lines.clone();
            let program = program.clone();
            async move {
                let mut lines = lines.lock().await;
                lines.read().await.map_err(|error| {
                    if let Some(pipe) = lines.take_failed_source() {
                        program.hold_failed_output(pipe);
                    }
                    Exception::throw_message(&ctx, &error.to_string())
                })
            }
        }),
    )
}
