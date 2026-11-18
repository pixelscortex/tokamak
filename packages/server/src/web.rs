//! Public shell bootstrap. Server data and plugin assets remain authenticated.
use axum::{
    extract::State,
    http::StatusCode,
    http::Uri,
    response::{IntoResponse, Response},
};
use std::{
    net::SocketAddr,
    path::{Component, PathBuf},
};

#[derive(Clone)]
pub struct HostedWeb {
    pub(crate) directory: PathBuf,
    pub(crate) origin: String,
}

impl HostedWeb {
    pub fn configure(
        directory: Option<PathBuf>,
        listen: SocketAddr,
    ) -> Result<Option<Self>, Box<dyn std::error::Error>> {
        let Some(directory) = directory else {
            return Ok(None);
        };
        let directory = std::fs::canonicalize(directory)?;
        if !directory.join("index.html").is_file() {
            return Err("--web must contain a built index.html".into());
        }
        let public =
            std::env::var("TOKAMAK_PUBLIC_URL").unwrap_or_else(|_| format!("http://{listen}"));
        let url = reqwest::Url::parse(&public)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "TOKAMAK_PUBLIC_URL must be an http(s) origin without a path or credentials".into(),
            );
        }
        Ok(Some(Self {
            directory,
            origin: url.origin().ascii_serialization(),
        }))
    }
}

pub(crate) async fn shell(State(web): State<HostedWeb>, uri: Uri) -> Response {
    let Ok(path) = percent_encoding::percent_decode_str(uri.path()).decode_utf8() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let relative = std::path::Path::new(path.trim_start_matches('/'));
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Reserve API namespaces even when their exact route does not exist.
    if matches!(relative.components().next(), Some(Component::Normal(name)) if matches!(name.to_str(), Some("ws" | "plugins" | "health" | "shutdown")))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let candidate = web.directory.join(relative);
    let file = match tokio::fs::canonicalize(&candidate).await {
        Ok(file) if file.is_file() => file,
        _ if !relative.starts_with("assets") => web.directory.join("index.html"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    // Canonicalization also prevents symlinks in the web directory escaping it.
    let Ok(file) = tokio::fs::canonicalize(file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !file.starts_with(&web.directory) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(bytes) = tokio::fs::read(&file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let hashed = relative.starts_with("assets")
        && file
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|stem| {
                let bytes = stem.as_bytes();
                bytes.len() > 9
                    && bytes[bytes.len() - 9] == b'-'
                    && bytes[bytes.len() - 8..]
                        .iter()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            })
        && file.file_name().is_some_and(|name| name != "index.html");
    let cache = if hashed {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (
                "content-type",
                mime_guess::from_path(&file)
                    .first_or_octet_stream()
                    .as_ref(),
            ),
            ("cache-control", cache),
            ("referrer-policy", "no-referrer"),
        ],
        bytes,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shell_fallback_cache_types_and_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("web");
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "<html>shell</html>").unwrap();
        std::fs::write(root.join("assets/app-12345678.js"), "export {};").unwrap();
        std::fs::write(directory.path().join("secret"), "private").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(directory.path().join("secret"), root.join("escape.txt"))
            .unwrap();
        let web = HostedWeb {
            directory: std::fs::canonicalize(root).unwrap(),
            origin: "https://example.test".into(),
        };
        for path in ["/", "/chat/thread/123", "/p/org.plugin", "/index.html"] {
            let response = shell(State(web.clone()), path.parse().unwrap()).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(response.headers()["cache-control"], "no-cache");
            assert_eq!(response.headers()["content-type"], "text/html");
        }
        let response = shell(
            State(web.clone()),
            "/assets/app-12345678.js".parse().unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(response.headers()["content-type"], "text/javascript");
        for path in [
            "/../secret",
            "/%2e%2e/secret",
            "/%2f..%2fsecret",
            "/escape.txt",
            "/plugins/missing",
            "/assets/missing.js",
        ] {
            assert_eq!(
                shell(State(web.clone()), path.parse().unwrap())
                    .await
                    .status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }
}
