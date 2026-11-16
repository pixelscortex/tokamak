//! Profile commands finish before starting the desktop window.
use runtime::client::{Error, data_directory, remote};

pub fn run() -> Result<bool, Error> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.is_empty() {
        return Ok(false);
    }
    match arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["join", link, "--name", name] => {
            let runtime = tokio_runtime()?;
            runtime.block_on(remote::join(&data_directory()?, link, name))?;
            println!("Joined remote server. Start the desktop to connect.");
        }
        ["leave"] => {
            remote::leave(&data_directory()?)?;
            println!("Remote profile removed. Start the desktop to connect locally.");
        }
        ["--help" | "-h"] => {
            println!(
                "Usage: tokamak-desktop [join <tokamak://join?server=…&code=…> --name <name> | leave]"
            );
        }
        _ => return Err("Usage: tokamak-desktop [join <link> --name <name> | leave]".into()),
    }
    Ok(true)
}

fn tokio_runtime() -> Result<tokio::runtime::Runtime, Error> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}
