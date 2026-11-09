#!/bin/sh
set -eu
proto run bun -- test tests/router.test.mjs tests/plugins.test.mjs
cargo test --locked --package runtime --all-features --jobs 2
