use std::{
    cell::RefCell,
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
};

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
pub struct Bundles {
    root: Rc<str>,
    providers: Rc<RefCell<HashMap<String, PathBuf>>>,
}

impl Bundles {
    pub fn new(code: &Path) -> anyhow::Result<Self> {
        let code = code
            .canonicalize()
            .context("Resolving local function bundle")?;
        let root = code
            .to_str()
            .context("Local function bundle path is not UTF-8")?;
        Ok(Self {
            root: Rc::from(root),
            providers: Rc::default(),
        })
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn allow_candidates(&self, candidates: &[serde_json::Value]) {
        for path in candidates
            .iter()
            .filter(|candidate| candidate["own"] == false)
            .filter_map(|candidate| candidate["path"].as_str())
        {
            self.allow(path);
        }
    }

    fn allow(&self, path: &str) {
        let code = Path::new(path);
        if code.is_absolute()
            && let Ok(resolved) = code.canonicalize()
        {
            self.providers
                .borrow_mut()
                .insert(path.to_owned(), resolved);
        }
    }

    fn path(&self, name: &str) -> Option<PathBuf> {
        if name == self.root() {
            Some(PathBuf::from(name))
        } else {
            self.providers.borrow().get(name).cloned()
        }
    }
}

pub struct Resolve(pub Bundles);

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

pub struct Load(pub Bundles);

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
