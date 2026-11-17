#!/bin/sh
set -eu
proto run bun -- test tests/css.test.ts tests/plugins.test.mjs tests/descriptor.test.ts
