#!/bin/sh
# Reproduce TKM-6 with only spike-local dependencies and a bounded Rust build.
set -eu
cd "$(dirname "$0")"
export CARGO_BUILD_JOBS=2
export RAYON_NUM_THREADS=2
bun install --frozen-lockfile
bun run css
bun run css:optimized
bun run css:focus-fallback
cargo fmt --check
cargo build --release --locked -j 2
./target/release/tailwind-blitz-probe > probe.log
./target/release/tailwind-blitz-probe --optimized > probe.optimized.log
./target/release/tailwind-blitz-probe --focus-fallback > probe.focus-fallback.log
python3 - <<'PY'
from pathlib import Path
import hashlib

# Evidence inventory, not a permanent test suite. Hashes let a reviewer verify
# that optimized/default match and the fallback changes only the focused state.
paths = sorted(Path('evidence').glob('*/*.png'))
paths += sorted(Path('.').glob('output*.css'))
lines = [f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.as_posix()}' for p in paths]
Path('evidence/SHA256SUMS').write_text('\n'.join(lines) + '\n')
print(f'Rendered {len(list(Path("evidence").glob("*/*.png")))} PNGs')
print(f'Standalone release probe: {Path("target/release/tailwind-blitz-probe").stat().st_size} bytes')
PY
