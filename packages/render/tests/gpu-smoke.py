#!/usr/bin/env python3
"""Opt-in real native demo smoke, not a headless GPU mock or input benchmark.

Run `moon run render:gpu-smoke` on a native graphical session. This builds the
production demo with upstream render/present-path diagnostics in a separate
target directory. It never launches the desktop app or opens a Notes datastore.
"""
import argparse
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time


# anyrender_vello 0.15.0 prints this timer only after successful
# maybe_blit_and_present() AND device.poll(wait_indefinitely()). Early frame
# skips do not print it. Requiring all stages avoids treating adapter init or
# a partial rendering diagnostic as evidence of a completed render/present path.
# Queue.present() returns unit; this does not verify compositor-visible pixels.
TIME = r"\d+(?:\.\d+)?(?:ns|us|ms|s)"
PRESENTED = re.compile(
    rf"^vello: {TIME} \(cmd: {TIME}, render: {TIME}, present: {TIME}, wait: {TIME}\)$"
)
ADAPTER = re.compile(
    r"^Tokamak GPU: (.+) \((Metal|Vulkan|Dx12|Gl), (IntegratedGpu|DiscreteGpu)\)$"
)
SOFTWARE = re.compile(r"llvmpipe|lavapipe|swiftshader|software", re.IGNORECASE)
FAILURE = re.compile(
    r"panicked at|validation error|device lost|failed to render|"
    r"requires a hardware GPU|UI host event:|UI event:|UI listener:|UI cleanup:",
    re.IGNORECASE,
)


def stop_and_reap(child):
    """Signal only our child, with bounded escalation; never search by name."""
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
    else:
        child.wait(timeout=2)


def observe(binary, *, deadline=15, minimum_seconds=3):
    # Python otherwise terminates immediately on SIGTERM, bypassing finally.
    # Record cancellation instead of raising inside Popen or cleanup: a signal
    # must not interrupt child creation before we own its handle, or its reap.
    terminated = False

    def terminate(_signal, _frame):
        nonlocal terminated
        terminated = True

    previous = signal.signal(signal.SIGTERM, terminate)
    try:
        return _observe(
            binary, deadline=deadline, minimum_seconds=minimum_seconds,
            cancelled=lambda: terminated,
        )
    finally:
        signal.signal(signal.SIGTERM, previous)


def _observe(binary, *, deadline, minimum_seconds, cancelled):
    started = time.monotonic()
    adapter = None
    frames = 0
    first_frame = None
    last_frame = None
    pending = b""
    received = 0
    child = subprocess.Popen(
        [str(binary)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        # Inherit the actual native display/adapter environment unchanged.
        # No HOME/global environment changes and no desktop datastore access.
        env=os.environ.copy(),
    )
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while time.monotonic() - started < deadline:
                if cancelled():
                    raise InterruptedError("native GPU smoke cancelled by SIGTERM")
                if child.poll() is not None:
                    raise RuntimeError(f"native demo exited early: {child.returncode}")
                for key, _ in selector.select(timeout=0.1):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        raise RuntimeError("native demo closed its diagnostic stream")
                    received += len(chunk)
                    if received > 1024 * 1024:
                        raise RuntimeError("native diagnostic output exceeded 1 MiB")
                    pending += chunk
                    while b"\n" in pending:
                        raw, pending = pending.split(b"\n", 1)
                        line = raw.decode("utf-8", errors="replace").strip()
                        print(line, flush=True)
                        if FAILURE.search(line):
                            raise RuntimeError(f"native failure diagnostic: {line}")
                        if line.startswith("Tokamak GPU: "):
                            match = ADAPTER.fullmatch(line)
                            if not match or SOFTWARE.search(match[1]):
                                raise RuntimeError(f"not a verified hardware adapter: {line}")
                            if sys.platform == "darwin" and match[2] != "Metal":
                                raise RuntimeError(f"macOS smoke requires actual Metal: {line}")
                            adapter = line
                        if PRESENTED.fullmatch(line):
                            frames += 1
                            last_frame = time.monotonic()
                            if first_frame is None:
                                first_frame = last_frame
                # Multiple completed paths spaced over time exercise the
                # demo's production host ticks while idle, not just first paint.
                if (
                    adapter is not None
                    and frames >= 3
                    and last_frame - first_frame >= 1
                    and time.monotonic() - started >= minimum_seconds
                ):
                    if cancelled():
                        raise InterruptedError("native GPU smoke cancelled by SIGTERM")
                    if child.poll() is not None:
                        raise RuntimeError("native demo failed after presenting")
                    print(f"PASS native GPU smoke: {adapter}; {frames} completed upstream render/present paths")
                    return
            raise RuntimeError(
                f"native GPU smoke deadline ({deadline}s): adapter={adapter!r}, "
                f"completed upstream render/present paths={frames}; a native display and hardware GPU "
                "are required, gpu-diagnostics must be enabled, and the demo must "
                "remain visible/unoccluded in an active unlocked graphical session"
            )
    finally:
        stop_and_reap(child)
        child.stdout.close()
        print(
            f"Reaped own demo child {child.pid}. Forced smoke termination is NOT "
            "graceful desktop/backend shutdown acceptance.",
            flush=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run", action="store_true",
        help="explicitly allow opening this smoke's native demo window",
    )
    args = parser.parse_args()
    if not args.run:
        parser.error("GUI smoke is opt-in; use moon run render:gpu-smoke")
    if sys.platform not in ("darwin", "linux"):
        parser.error("this native pipe supervisor currently supports macOS and Linux only")
    root = Path(__file__).resolve().parents[3]
    try:
        subprocess.run(
            [
                "cargo", "build", "--locked", "--release", "--package", "render",
                "--bin", "demo", "--features", "gpu-diagnostics", "--jobs", "2",
                "--target-dir", str(root / "target/gpu-smoke"),
            ],
            cwd=root, check=True, timeout=600,
        )
        observe(root / "target/gpu-smoke/release" / ("demo.exe" if os.name == "nt" else "demo"))
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"FAIL native GPU smoke: {error}", file=sys.stderr)
        return 1
    print(
        "Evidence: hardware adapter selection + completed upstream render/present path. "
        "Not proof of visible pixels, physical mouse/IME, resize/DPI, suspend, "
        "surface/device-loss recovery, GPU utilization, frame rate or input latency."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
