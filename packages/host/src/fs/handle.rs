use std::{
    fs::File,
    io::{self, Read, Write},
    os::fd::AsRawFd,
    os::unix::fs::{FileExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use rquickjs::{Ctx, Object, Result, TypedArray};

use super::{blocking, metadata, owned_bytes};

#[derive(rquickjs::class::Trace, rquickjs::JsLifetime)]
#[rquickjs::class]
pub struct FileHandle {
    #[qjs(skip_trace)]
    file: Arc<Mutex<Option<File>>>,
    #[qjs(skip_trace)]
    path: PathBuf,
}

#[rquickjs::methods(rename_all = "camelCase")]
impl FileHandle {
    #[qjs(skip)]
    pub fn new(file: File, path: PathBuf) -> Self {
        Self {
            file: Arc::new(Mutex::new(Some(file))),
            path,
        }
    }

    #[qjs(get)]
    pub fn fd(&self) -> i32 {
        self.file
            .lock()
            .ok()
            .and_then(|file| file.as_ref().map(AsRawFd::as_raw_fd))
            .unwrap_or(-1)
    }

    pub async fn close(&self, ctx: Ctx<'_>) -> Result<()> {
        let file = self.file.clone();
        blocking(&ctx, &self.path, None, move || {
            file.lock()
                .map_err(|_| io::Error::other("File handle lock poisoned"))?
                .take();
            Ok(())
        })
        .await
    }

    pub async fn read_bytes<'js>(&self, ctx: Ctx<'js>) -> Result<TypedArray<'js, u8>> {
        let data = self
            .with_file(&ctx, |file| {
                let mut data = Vec::new();
                file.read_to_end(&mut data)?;
                Ok(data)
            })
            .await?;
        TypedArray::new(ctx, data)
    }

    pub async fn write_bytes<'js>(&self, ctx: Ctx<'js>, data: TypedArray<'js, u8>) -> Result<()> {
        let data = owned_bytes(&ctx, &data)?;
        self.with_file(&ctx, move |file| file.write_all(&data))
            .await
    }

    pub async fn stat<'js>(&self, ctx: Ctx<'js>) -> Result<Object<'js>> {
        let info = self.with_file(&ctx, |file| file.metadata()).await?;
        metadata(&ctx, &info)
    }

    pub async fn read_chunk<'js>(
        &self,
        ctx: Ctx<'js>,
        length: usize,
        position: Option<u64>,
    ) -> Result<TypedArray<'js, u8>> {
        let data = self
            .with_file(&ctx, move |file| {
                let mut data = vec![0; length];
                let size = match position {
                    Some(position) => file.read_at(&mut data, position)?,
                    None => file.read(&mut data)?,
                };
                data.truncate(size);
                Ok(data)
            })
            .await?;
        TypedArray::new(ctx, data)
    }

    pub async fn write_chunk<'js>(
        &self,
        ctx: Ctx<'js>,
        data: TypedArray<'js, u8>,
        position: Option<u64>,
    ) -> Result<usize> {
        let data = owned_bytes(&ctx, &data)?;
        self.with_file(&ctx, move |file| match position {
            Some(position) => file.write_at(&data, position),
            None => file.write(&data),
        })
        .await
    }

    pub async fn chmod(&self, ctx: Ctx<'_>, mode: u32) -> Result<()> {
        self.with_file(&ctx, move |file| {
            file.set_permissions(std::fs::Permissions::from_mode(mode))
        })
        .await
    }

    pub async fn chown(&self, ctx: Ctx<'_>, uid: u32, gid: u32) -> Result<()> {
        self.with_file(&ctx, move |file| {
            // SAFETY: The open file owns the descriptor for the duration of this call.
            if unsafe { libc::fchown(file.as_raw_fd(), uid, gid) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        })
        .await
    }

    pub async fn sync(&self, ctx: Ctx<'_>) -> Result<()> {
        self.with_file(&ctx, |file| file.sync_all()).await
    }

    pub async fn datasync(&self, ctx: Ctx<'_>) -> Result<()> {
        self.with_file(&ctx, |file| file.sync_data()).await
    }

    pub async fn truncate(&self, ctx: Ctx<'_>, length: u64) -> Result<()> {
        self.with_file(&ctx, move |file| file.set_len(length)).await
    }
}

impl FileHandle {
    async fn with_file<T: Send + 'static>(
        &self,
        ctx: &Ctx<'_>,
        operation: impl FnOnce(&mut File) -> io::Result<T> + Send + 'static,
    ) -> Result<T> {
        let file = self.file.clone();
        blocking(ctx, &self.path, None, move || {
            let mut file = file
                .lock()
                .map_err(|_| io::Error::other("File handle lock poisoned"))?;
            let file = file
                .as_mut()
                .ok_or_else(|| io::Error::from_raw_os_error(libc::EBADF))?;
            Ok(operation(file)?)
        })
        .await
    }
}
