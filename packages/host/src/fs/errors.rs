use std::{
    io,
    path::{Path, PathBuf},
};

use rquickjs::{Ctx, Exception};

pub type Result<T> = std::result::Result<T, FsError>;

pub struct FsError {
    code: &'static str,
    message: String,
    errno: Option<i32>,
    path: Option<PathBuf>,
}

impl FsError {
    pub fn new(code: &'static str, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
            errno: None,
            path: None,
        }
    }

    pub fn invalid(message: &str) -> Self {
        Self::new("ERR_INVALID_ARG_VALUE", message)
    }

    pub fn at(mut self, path: &Path) -> Self {
        self.path = Some(path.to_owned());
        self
    }

    pub fn throw(self, ctx: &Ctx<'_>, path: &Path, dest: Option<&Path>) -> rquickjs::Error {
        let error = (|| {
            let error = Exception::from_message(ctx.clone(), &self.message)?;
            error.as_object().set("code", self.code)?;
            error.as_object().set(
                "path",
                self.path
                    .as_deref()
                    .unwrap_or(path)
                    .to_string_lossy()
                    .as_ref(),
            )?;
            if let Some(errno) = self.errno {
                error.as_object().set("errno", -errno)?;
            }
            if let Some(dest) = dest {
                error
                    .as_object()
                    .set("dest", dest.to_string_lossy().as_ref())?;
            }
            Ok::<_, rquickjs::Error>(error)
        })();
        match error {
            Ok(error) => error.throw(),
            Err(error) => error,
        }
    }
}

impl From<io::Error> for FsError {
    fn from(error: io::Error) -> Self {
        let errno = error.raw_os_error();
        let code = errno.map_or("ERR_INVALID_ARG_VALUE", errno_name);
        Self {
            code,
            errno,
            message: error.to_string(),
            path: None,
        }
    }
}

fn errno_name(number: i32) -> &'static str {
    macro_rules! names {
        ($($name:ident),* $(,)?) => {
            match number {
                $(libc::$name => stringify!($name),)*
                _ => "UNKNOWN",
            }
        };
    }
    names!(
        EACCES,
        EAGAIN,
        EBADF,
        EBUSY,
        EDQUOT,
        EEXIST,
        EFAULT,
        EFBIG,
        EILSEQ,
        EINTR,
        EINVAL,
        EIO,
        EISDIR,
        ELOOP,
        EMFILE,
        EMLINK,
        ENAMETOOLONG,
        ENFILE,
        ENODEV,
        ENOENT,
        ENOMEM,
        ENOSPC,
        ENOSYS,
        ENOTDIR,
        ENOTEMPTY,
        ENOTSUP,
        ENOTTY,
        ENXIO,
        EOVERFLOW,
        EPERM,
        EPIPE,
        EROFS,
        ESPIPE,
        ESTALE,
        ETIMEDOUT,
        ETXTBSY,
        EXDEV,
    )
}
