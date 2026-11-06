#!/usr/bin/env python3
# TKM-1 regression: real moon builds must use the project pin, not rustup's
# user default. Opt-in because this needs two already-installed Rust versions.
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def main():
    root = Path(__file__).resolve().parents[1]
    pin = re.search(r'^rust\s*=\s*"([^"]+)"', (root / '.prototools').read_text(), re.M)[1]
    home = Path(run('rustup', 'show', 'home', cwd=root))
    installed = sorted((home / 'toolchains').iterdir())
    versions = {p: run(str(p / 'bin/rustc'), '--version').split()[1] for p in installed}
    pinned = next((p for p in installed if versions[p] == pin), None)
    other = next((p for p in installed if versions[p] != pin), None)
    if not pinned or not other:
        sys.exit('UNMET PREREQUISITE: install the pinned Rust and a different Rust '
                 'compiler beforehand; this test never downloads compilers.')

    # Copy sources, not build caches: both exact moon commands must compile.
    # All generated files and isolated settings disappear even after failure.
    with tempfile.TemporaryDirectory(prefix='tokamak-compiler-') as temporary:
        scratch = Path(temporary)
        project = scratch / 'project'
        # Moon needs an existing HEAD; clone metadata without creating commits.
        subprocess.run(['git', 'clone', '--quiet', '--local', '--no-checkout',
                        str(root), str(project)], check=True)
        shutil.copytree(root, project, dirs_exist_ok=True, ignore=shutil.ignore_patterns(
            '.git', 'target', 'node_modules', 'dist', '.proto', 'cache', '.codegraph'))
        isolated = scratch / 'rustup'
        (isolated / 'toolchains').mkdir(parents=True)
        for compiler in (pinned, other):
            (isolated / 'toolchains' / compiler.name).symlink_to(compiler, target_is_directory=True)
        (isolated / 'settings.toml').write_text(
            'version = "12"\ndefault_toolchain = "' + other.name + '"\n')
        log = scratch / 'compiler.log'
        wrapper = scratch / 'rustc-wrapper'
        # Record only actual crate compilations, not Cargo's version probes,
        # then forward unchanged to the exact compiler Cargo selected.
        wrapper.write_text(f'#!{sys.executable}\n' + '''import os, subprocess, sys
if '--crate-name' in sys.argv and any(a.startswith('--emit') for a in sys.argv):
    with open(os.environ['COMPILER_LOG'], 'a') as log:
        log.write(subprocess.check_output([sys.argv[1], '--version'], text=True))
os.execv(sys.argv[1], sys.argv[1:])
''')
        wrapper.chmod(0o755)
        env = dict(os.environ, RUSTUP_HOME=str(isolated), RUSTUP_AUTO_INSTALL='0',
                   RUSTC_WRAPPER=str(wrapper), COMPILER_LOG=str(log),
                   CARGO_TARGET_DIR=str(project / 'target'))
        # Inherited overrides could conceal the regression or bypass rustup.
        for key in ('RUSTUP_TOOLCHAIN', 'RUSTC', 'RUSTC_WORKSPACE_WRAPPER'):
            env.pop(key, None)
        assert run('rustc', '--version', cwd=scratch, env=env).split()[1] != pin
        for task in (':build', ':size'):
            shutil.rmtree(project / 'target', ignore_errors=True)
            log.unlink(missing_ok=True)
            subprocess.run(['moon', 'run', task], cwd=project, env=env, check=True)
            observed = log.read_text().splitlines() if log.exists() else []
            if not observed or any(line.split()[1] != pin for line in observed):
                sys.exit(f'FAIL {task}: expected real compilation with Rust {pin}; '
                         f'observed {observed}')
            print(f'PASS moon run {task}: {len(observed)} compilations with Rust {pin}; '
                  f'isolated default is Rust {versions[other]}', flush=True)


if __name__ == '__main__':
    main()
