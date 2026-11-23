use std::path::PathBuf;

use rquickjs::{
    Ctx, Exception, Module, Result,
    loader::{ImportAttributes, Loader, Resolver},
    module::{Declarations, Declared, Exports, ModuleDef},
    prelude::{Async, Func},
};

pub struct Resolve(pub String);

impl Resolver for Resolve {
    fn resolve<'js>(
        &mut self,
        _: &Ctx<'js>,
        base: &str,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> Result<String> {
        let name = match name {
            "path" => "node:path",
            "os" => "node:os",
            "crypto" => "node:crypto",
            "url" => "node:url",
            "fs/promises" => "node:fs/promises",
            _ => name,
        };
        if matches!(
            name,
            "node:path" | "node:fs/promises" | "node:os" | "node:crypto" | "node:url"
        ) || (base == "tokamak:entry" && name == self.0)
            || (base == "node:fs/promises" && matches!(name, "tokamak:fs" | "tokamak:fs-extra"))
        {
            Ok(name.to_owned())
        } else {
            Err(rquickjs::Error::new_resolving(base, name))
        }
    }
}

pub struct Load(pub PathBuf);

impl Loader for Load {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, Declared>> {
        let ctx = ctx.clone();
        match name {
            "node:path" => Module::declare_def::<llrt_path::PathModule, _>(ctx, name),
            "node:os" => Module::declare_def::<llrt_os::OsModule, _>(ctx, name),
            "node:crypto" => Module::declare_def::<llrt_crypto::CryptoModule, _>(ctx, name),
            "node:url" => Module::declare_def::<llrt_url::UrlModule, _>(ctx, name),
            "node:fs/promises" => Module::declare(ctx, name, include_str!("fs.js")),
            "tokamak:fs" => Module::declare_def::<llrt_fs::FsPromisesModule, _>(ctx, name),
            "tokamak:fs-extra" => Module::declare_def::<ExtraFs, _>(ctx, name),
            _ if self.0.to_str() == Some(name) => {
                Module::declare(ctx, name, std::fs::read(&self.0)?)
            }
            _ => Err(rquickjs::Error::new_loading(name)),
        }
    }
}

struct ExtraFs;

impl ModuleDef for ExtraFs {
    fn declare(declarations: &Declarations) -> Result<()> {
        declarations
            .declare("realpath")?
            .declare("unlink")?
            .declare("copyFile")?
            .declare("mkdirAll")?;
        Ok(())
    }

    fn evaluate<'js>(_: &Ctx<'js>, exports: &Exports<'js>) -> Result<()> {
        exports.export("realpath", Func::from(Async(realpath)))?;
        exports.export("unlink", Func::from(Async(unlink)))?;
        exports.export("copyFile", Func::from(Async(copy_file)))?;
        exports.export("mkdirAll", Func::from(Async(mkdir_all)))?;
        Ok(())
    }
}

async fn realpath(ctx: Ctx<'_>, path: String) -> Result<String> {
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| io_exception(&ctx, error))?;
    path.into_os_string()
        .into_string()
        .map_err(|_| Exception::throw_message(&ctx, "Path is not UTF-8"))
}

async fn unlink(ctx: Ctx<'_>, path: String) -> Result<()> {
    tokio::fs::remove_file(path)
        .await
        .map_err(|error| io_exception(&ctx, error))
}

async fn mkdir_all(ctx: Ctx<'_>, path: String) -> Result<()> {
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|error| io_exception(&ctx, error))
}

async fn copy_file(
    ctx: Ctx<'_>,
    from: String,
    to: String,
    preserve_timestamps: bool,
) -> Result<()> {
    let copy = tokio::task::spawn_blocking(move || {
        let times = if preserve_timestamps {
            let metadata = std::fs::metadata(&from)?;
            Some(
                std::fs::FileTimes::new()
                    .set_accessed(metadata.accessed()?)
                    .set_modified(metadata.modified()?),
            )
        } else {
            None
        };
        std::fs::copy(from, &to)?;
        if let Some(times) = times {
            std::fs::File::open(to)?.set_times(times)?;
        }
        Ok(())
    });
    copy.await
        .map_err(|error| Exception::throw_message(&ctx, &error.to_string()))?
        .map_err(|error| io_exception(&ctx, error))
}

fn io_exception(ctx: &Ctx<'_>, error: std::io::Error) -> rquickjs::Error {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::IsADirectory => "EISDIR",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        _ => "EIO",
    };
    let exception = (|| {
        let exception = Exception::from_message(ctx.clone(), &error.to_string())?;
        exception.as_object().set("code", code)?;
        Ok::<_, rquickjs::Error>(exception)
    })();
    match exception {
        Ok(exception) => exception.throw(),
        Err(error) => error,
    }
}
