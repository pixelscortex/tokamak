use std::{path::Path, process::Command};

pub(super) fn server_command(binary: &Path) -> Command {
    let command = Command::new(binary);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

        let mut command = command;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    command
}
