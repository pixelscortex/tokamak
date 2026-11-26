#!/bin/sh
set -eu
# Bun and the TypeScript checker change their output when they see an agent,
# and these tests read that output.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT AI_AGENT AGENT
proto run bun -- test tests/browser.test.ts tests/css.test.ts tests/plugins.test.mjs tests/descriptor.test.ts tests/contracts.test.mjs tests/refs.test.mjs tests/triggers.test.mjs tests/boundary.test.mjs tests/components.test.mjs tests/local.test.mjs tests/window-state.test.mjs
proto run bun -- run vitest run
