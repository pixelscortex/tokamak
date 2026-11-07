//! Native element showcase embeds Vite JS and the generated Tailwind shell.
//! The worker's typed ticks must update Solid without input/redraw polling hacks.
use serde::Serialize;
use std::{thread, time::Duration};

#[derive(Serialize)]
struct Tick {
    count: u64,
}

fn main() -> render::Result<()> {
    render::launch(
        include_str!("../../dist/shell.html"),
        include_str!("../../dist/demo.js"),
        "Tokamak TKM-8",
        |sender| {
            thread::spawn(move || {
                for count in 1.. {
                    thread::sleep(Duration::from_secs(1));
                    if sender.send("tick", Tick { count }).is_err() {
                        break;
                    }
                }
            });
        },
    )
}
