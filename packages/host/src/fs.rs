mod copy;
mod errors;
mod handle;

use std::{
    ffi::CString,
    fs::{self, DirBuilder, FileType, Metadata, OpenOptions, Permissions},
    io::{self, Write},
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt, symlink},
    },
    path::{Path, PathBuf},
};

use rquickjs::{
    Array, Ctx, Exception, Object, Result, TypedArray, Value,
    module::{Declarations, Exports, ModuleDef},
    prelude::{Async, Func},
};

use self::{copy::CopyOptions, errors::FsError, handle::FileHandle};

pub struct NativeFs;

impl ModuleDef for NativeFs {
    fn declare(exports: &Declarations) -> Result<()> {
        exports.declare("run")?;
        Ok(())
    }

    fn evaluate<'js>(ctx: &Ctx<'js>, exports: &Exports<'js>) -> Result<()> {
        rquickjs::Class::<FileHandle>::define(&ctx.globals())?;
        exports.export("run", Func::from(Async(run)))?;
        Ok(())
    }
}

enum Reply {
    None,
    Bytes(Vec<u8>),
    Entries(Vec<(PathBuf, FileType)>),
    Stat(Metadata),
    File(fs::File),
}

async fn run<'js>(
    ctx: Ctx<'js>,
    operation: String,
    path: TypedArray<'js, u8>,
    args: Object<'js>,
) -> Result<Value<'js>> {
    use rquickjs::IntoJs;

    let path = path_from_bytes(&ctx, &path)?;
    let other = args.get::<_, Option<TypedArray<u8>>>("dest")?;
    let other = other
        .as_ref()
        .map(|bytes| path_from_bytes(&ctx, bytes))
        .transpose()?;
    let data = args.get::<_, Option<TypedArray<u8>>>("data")?;
    let data = data
        .as_ref()
        .map(|bytes| owned_bytes(&ctx, bytes))
        .transpose()?;
    let option = |name| args.get::<_, Option<bool>>(name);
    let recursive = option("recursive")?.unwrap_or(false);
    let force = option("force")?.unwrap_or(operation == "cp");
    let cmd = Command {
        name: operation,
        flags: args.get::<_, Option<String>>("flag")?,
        mode: args.get::<_, Option<u32>>("mode")?,
        recursive,
        force,
        copy: CopyOptions {
            recursive,
            force,
            dereference: option("dereference")?.unwrap_or(false),
            error_on_exist: option("errorOnExist")?.unwrap_or(false),
            preserve_timestamps: option("preserveTimestamps")?.unwrap_or(false),
        },
        data,
    };
    let operand = path.clone();
    let dest = other.clone();
    let result = blocking(&ctx, &path, other.as_deref(), move || {
        cmd.run(&operand, dest.as_deref())
    })
    .await?;
    match result {
        Reply::None => ().into_js(&ctx),
        Reply::Bytes(bytes) => TypedArray::new(ctx.clone(), bytes)?.into_js(&ctx),
        Reply::Entries(entries) => {
            let output = Array::new(ctx.clone())?;
            for (index, (path, kind)) in entries.into_iter().enumerate() {
                let entry = Array::new(ctx.clone())?;
                entry.set(
                    0,
                    TypedArray::new_copy(ctx.clone(), path.as_os_str().as_bytes())?,
                )?;
                entry.set(1, file_kind(kind))?;
                output.set(index, entry)?;
            }
            output.into_js(&ctx)
        }
        Reply::Stat(info) => metadata(&ctx, &info)?.into_js(&ctx),
        Reply::File(file) => {
            rquickjs::Class::instance(ctx.clone(), FileHandle::new(file, path))?.into_js(&ctx)
        }
    }
}

struct Command {
    name: String,
    flags: Option<String>,
    mode: Option<u32>,
    recursive: bool,
    force: bool,
    copy: CopyOptions,
    data: Option<Vec<u8>>,
}

impl Command {
    fn run(self, path: &Path, dest: Option<&Path>) -> errors::Result<Reply> {
        let dest = || dest.ok_or_else(|| FsError::invalid("Expected a destination path"));
        match self.name.as_str() {
            "access" => {
                let path = CString::new(path.as_os_str().as_bytes())
                    .map_err(|_| FsError::invalid("Path must not contain null bytes"))?;
                // SAFETY: The CString keeps the terminated path valid through access.
                if unsafe { libc::access(path.as_ptr(), self.mode.unwrap_or(0) as i32) } != 0 {
                    return Err(io::Error::last_os_error().into());
                }
            }
            "chmod" => fs::set_permissions(
                path,
                Permissions::from_mode(
                    self.mode
                        .ok_or_else(|| FsError::invalid("Expected a file mode"))?,
                ),
            )?,
            "cp" => self.copy.copy(path, dest()?)?,
            "lstat" => return Ok(Reply::Stat(fs::symlink_metadata(path)?)),
            "mkdir" => return mkdir(path, self.recursive, self.mode),
            "mkdtemp" => return Ok(Reply::Bytes(mkdtemp(path)?)),
            "open" => {
                return Ok(Reply::File(open(
                    path,
                    self.flags.as_deref().unwrap_or("r"),
                    self.mode,
                )?));
            }
            "readFile" => {
                let file = open(path, self.flags.as_deref().unwrap_or("r"), None)?;
                return Ok(Reply::Bytes(after_open_read(file)?));
            }
            "readdir" => {
                let mut entries = Vec::new();
                read_directory(path, Path::new(""), self.recursive, &mut entries)?;
                return Ok(Reply::Entries(entries));
            }
            "realpath" => {
                return Ok(Reply::Bytes(
                    path.canonicalize()?.into_os_string().into_vec(),
                ));
            }
            "rename" => fs::rename(path, dest()?)?,
            "rm" => remove(path, self.recursive, self.force)?,
            "rmdir" if self.recursive => fs::remove_dir_all(path)?,
            "rmdir" => fs::remove_dir(path)?,
            "stat" => return Ok(Reply::Stat(fs::metadata(path)?)),
            "symlink" => {
                let dest = dest()?;
                symlink(path, dest).map_err(|error| FsError::from(error).at(dest))?;
            }
            "unlink" => fs::remove_file(path)?,
            "writeFile" => {
                let mut file = open(path, self.flags.as_deref().unwrap_or("w"), self.mode)?;
                file.write_all(
                    &self
                        .data
                        .ok_or_else(|| FsError::invalid("Expected file data"))?,
                )?;
            }
            _ => return Err(FsError::invalid("Unknown filesystem operation")),
        }
        Ok(Reply::None)
    }
}

fn mkdir(path: &Path, recursive: bool, mode: Option<u32>) -> errors::Result<Reply> {
    let mut builder = DirBuilder::new();
    builder.recursive(recursive).mode(mode.unwrap_or(0o777));
    let first = if recursive {
        first_missing(path)?
    } else {
        None
    };
    builder.create(path)?;
    Ok(first.map_or(Reply::None, |dir| {
        Reply::Bytes(dir.into_os_string().into_vec())
    }))
}

fn mkdtemp(path: &Path) -> errors::Result<Vec<u8>> {
    let mut bytes = path.as_os_str().as_bytes().to_vec();
    bytes.extend_from_slice(b"XXXXXX");
    let bytes =
        CString::new(bytes).map_err(|_| FsError::invalid("Path must not contain null bytes"))?;
    let mut bytes = bytes.into_bytes_with_nul();
    // SAFETY: mkdtemp replaces Xs in this writable, null-terminated template.
    if unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) }.is_null() {
        return Err(io::Error::last_os_error().into());
    }
    bytes.pop();
    Ok(bytes)
}

fn remove(path: &Path, recursive: bool, force: bool) -> errors::Result<()> {
    let result = match fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() && recursive => fs::remove_dir_all(path),
        Ok(info) if info.is_dir() => {
            return Err(FsError::new(
                "ERR_FS_EISDIR",
                "Cannot remove a directory without recursive",
            ));
        }
        Ok(_) => fs::remove_file(path),
        Err(error) => Err(error),
    };
    match result {
        Err(ref error) if force && error.raw_os_error() == Some(libc::ENOENT) => Ok(()),
        other => other.map_err(Into::into),
    }
}

fn open(path: &Path, flags: &str, mode: Option<u32>) -> errors::Result<fs::File> {
    let mut options = OpenOptions::new();
    let flags = match flags {
        "r" => libc::O_RDONLY,
        "r+" => libc::O_RDWR,
        "rs" | "sr" => libc::O_RDONLY | libc::O_SYNC,
        "rs+" | "sr+" => libc::O_RDWR | libc::O_SYNC,
        "w" => libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
        "w+" => libc::O_RDWR | libc::O_CREAT | libc::O_TRUNC,
        "wx" | "xw" => libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        "wx+" | "xw+" => libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        "a" => libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
        "a+" => libc::O_RDWR | libc::O_CREAT | libc::O_APPEND,
        "ax" | "xa" => libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_APPEND,
        "ax+" | "xa+" => libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_APPEND,
        "as" | "sa" => libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND | libc::O_SYNC,
        "as+" | "sa+" => libc::O_RDWR | libc::O_CREAT | libc::O_APPEND | libc::O_SYNC,
        _ => return Err(FsError::invalid("Invalid file open flags")),
    };
    let access = flags & libc::O_ACCMODE;
    Ok(options
        .read(access != libc::O_WRONLY)
        .write(access != libc::O_RDONLY)
        .custom_flags(flags)
        .mode(mode.unwrap_or(0o666))
        .open(path)?)
}

fn after_open_read(mut file: fs::File) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;
    Ok(data)
}

fn first_missing(path: &Path) -> io::Result<Option<PathBuf>> {
    let mut first = None;
    for dir in path
        .ancestors()
        .take_while(|dir| !dir.as_os_str().is_empty())
    {
        match fs::metadata(dir) {
            Ok(_) => break,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
                first = Some(dir.to_owned())
            }
            Err(error) => return Err(error),
        }
    }
    Ok(first)
}

fn read_directory(
    root: &Path,
    relative: &Path,
    recursive: bool,
    output: &mut Vec<(PathBuf, FileType)>,
) -> io::Result<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let name = relative.join(entry.file_name());
        let kind = entry.file_type()?;
        if recursive && kind.is_dir() {
            read_directory(root, &name, recursive, output)?;
        }
        output.push((name, kind));
    }
    Ok(())
}

fn file_kind(kind: FileType) -> &'static str {
    if kind.is_file() {
        "File"
    } else if kind.is_dir() {
        "Directory"
    } else if kind.is_symlink() {
        "SymbolicLink"
    } else if kind.is_fifo() {
        "FIFO"
    } else if kind.is_block_device() {
        "BlockDevice"
    } else if kind.is_char_device() {
        "CharacterDevice"
    } else if kind.is_socket() {
        "Socket"
    } else {
        ""
    }
}

fn metadata<'js>(ctx: &Ctx<'js>, info: &Metadata) -> Result<Object<'js>> {
    let result = Object::new(ctx.clone())?;
    result.set("kind", file_kind(info.file_type()))?;
    result.set("dev", info.dev())?;
    result.set("ino", info.ino())?;
    result.set("mode", info.mode())?;
    result.set("nlink", info.nlink())?;
    result.set("uid", info.uid())?;
    result.set("gid", info.gid())?;
    result.set("rdev", info.rdev())?;
    result.set("size", info.size())?;
    result.set("blksize", info.blksize())?;
    result.set("blocks", info.blocks())?;
    result.set("atimeMs", milliseconds(info.atime(), info.atime_nsec()))?;
    result.set("mtimeMs", milliseconds(info.mtime(), info.mtime_nsec()))?;
    result.set("ctimeMs", milliseconds(info.ctime(), info.ctime_nsec()))?;
    result.set(
        "birthtimeMs",
        info.created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |time| time.as_secs_f64() * 1000.0),
    )?;
    Ok(result)
}

fn milliseconds(seconds: i64, nanos: i64) -> f64 {
    seconds as f64 * 1000.0 + nanos as f64 / 1_000_000.0
}

fn owned_bytes(ctx: &Ctx<'_>, bytes: &TypedArray<'_, u8>) -> Result<Vec<u8>> {
    // SAFETY: Copy immediately without running JS or exposing the borrowed bytes.
    unsafe { bytes.as_bytes() }
        .map(<[u8]>::to_vec)
        .ok_or_else(|| Exception::throw_type(ctx, "Expected a live byte array"))
}

fn path_from_bytes(ctx: &Ctx<'_>, bytes: &TypedArray<'_, u8>) -> Result<PathBuf> {
    Ok(std::ffi::OsString::from_vec(owned_bytes(ctx, bytes)?).into())
}

async fn blocking<T: Send + 'static>(
    ctx: &Ctx<'_>,
    path: &Path,
    dest: Option<&Path>,
    run: impl FnOnce() -> errors::Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|error| Exception::throw_message(ctx, &error.to_string()))?
        .map_err(|error| error.throw(ctx, path, dest))
}
