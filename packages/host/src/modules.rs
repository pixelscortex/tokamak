use std::{path::Path, rc::Rc};

use anyhow::Context;

use rquickjs::{
    Ctx, Exception, Module, Result,
    loader::{ImportAttributes, Loader, Resolver},
    module::Declared,
};

use crate::{
    builtins::{action_builtin, load_builtin},
    fs::NativeFs,
};

#[derive(Clone)]
pub struct Bundle(Rc<str>);

impl Bundle {
    pub fn new(code: &Path) -> anyhow::Result<Self> {
        let code = code
            .canonicalize()
            .context("Resolving caller action bundle")?;
        let root = code
            .to_str()
            .context("Caller action bundle path is not UTF-8")?;
        Ok(Self(Rc::from(root)))
    }

    pub fn root(&self) -> &str {
        &self.0
    }

    fn path(&self, name: &str) -> Option<&Path> {
        (name == self.root()).then_some(Path::new(self.root()))
    }
}

pub struct Resolve(pub Bundle);

impl Resolver for Resolve {
    fn resolve<'js>(
        &mut self,
        ctx: &Ctx<'js>,
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
        ) || (base == "tokamak:entry" && self.0.path(name).is_some())
            || (base == "node:fs/promises" && name == "tokamak:fs")
            || (base == "node:path" && name == "tokamak:path")
        {
            Ok(name.to_owned())
        } else {
            Err(Exception::throw_reference(
                ctx,
                &format!("Module is not allowed on the plugin host: {name} (imported from {base})"),
            ))
        }
    }
}

pub struct Load(pub Bundle);

impl Loader for Load {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, Declared>> {
        let ctx = ctx.clone();
        match name {
            name if name == "tokamak:path" || action_builtin(name).is_some() => {
                load_builtin(ctx, name)
            }
            "node:fs/promises" => Module::declare(ctx, name, include_str!("fs.js")),
            "tokamak:fs" => Module::declare_def::<NativeFs, _>(ctx, name),
            _ => {
                let path = self
                    .0
                    .path(name)
                    .ok_or_else(|| rquickjs::Error::new_loading(name))?;
                Module::declare(ctx, name, std::fs::read(path)?)
            }
        }
    }
}
