//! Standalone native acceptance surface. The worker owns only a typed sender;
//! its idle ticks must update Solid without keyboard/mouse/redraw polling hacks.
use serde::Serialize;
use std::{thread, time::Duration};

#[derive(Serialize)]
struct Tick {
    count: u64,
}

fn main() -> render::Result<()> {
    render::launch(
        include_str!("../../demo/shell.html"),
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
