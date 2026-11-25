use rquickjs::{Ctx, Module, Result, module::Declared};

pub(crate) fn action_builtin(name: &str) -> Option<&'static str> {
    match name {
        "path" | "node:path" => Some("node:path"),
        "os" | "node:os" => Some("node:os"),
        "crypto" | "node:crypto" => Some("node:crypto"),
        "url" | "node:url" => Some("node:url"),
        _ => None,
    }
}

pub(crate) fn load_builtin<'js>(ctx: Ctx<'js>, name: &str) -> Result<Module<'js, Declared>> {
    match name {
        "node:path" => Module::declare(ctx, name, include_str!("path.js")),
        "tokamak:path" => Module::declare_def::<llrt_path::PathModule, _>(ctx, name),
        "node:os" => Module::declare_def::<llrt_os::OsModule, _>(ctx, name),
        "node:crypto" => Module::declare_def::<llrt_crypto::CryptoModule, _>(ctx, name),
        "node:url" => Module::declare_def::<llrt_url::UrlModule, _>(ctx, name),
        _ => Err(rquickjs::Error::new_loading(name)),
    }
}
