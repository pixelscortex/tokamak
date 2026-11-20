#!/bin/sh
set -eu
proto run bun -- test tests/browser.test.ts tests/css.test.ts tests/plugins.test.mjs tests/descriptor.test.ts tests/boundary.test.mjs tests/outside.test.mjs tests/public-types.test.mjs tests/type-lookup.test.mjs tests/shared-window.test.mjs tests/shared-app.test.mjs
