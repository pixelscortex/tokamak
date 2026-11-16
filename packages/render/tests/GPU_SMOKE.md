# Opt-in native GPU acceptance

Run `moon run render:gpu-smoke` from the workspace root in an active, unlocked
native graphical session with a hardware GPU. Keep this task's demo window
visible and unoccluded during observation. Python 3.8+, the pinned project toolchain, and the
usual native build dependencies are required. Missing display/GPU prerequisites
fail this explicitly requested task; they are not silently skipped.

The task builds the **production demo** with the default-off `gpu-diagnostics`
feature, using a separate `target/gpu-smoke` directory so normal release binaries
are not replaced with instrumented ones. This feature forwards upstream
AnyRender diagnostics; it is not a mock renderer or a new application mode.
Normal `render:test`, UI/app tests and workspace headless tests do not launch it.
Blitz beta.4 paints once on resume, but suppresses subsequent redraws when
occluded. One initial timing line followed by a deadline is consistent with
occlusion, not proof of it or a renderer defect. This smoke fails closed; it
does not activate windows or lower its repeated-path threshold for that case.

The smoke requires both:

- An actual hardware adapter diagnostic (integrated/discrete; Metal on macOS).
- At least three complete upstream `vello:` timing lines, including `cmd`,
  `render`, `present`, and `wait`, spaced over at least one second, with the
  child still alive for at least three seconds.

In pinned `anyrender_vello` 0.15.0, the complete timing line is printed only after
`maybe_blit_and_present()` succeeds and the device completion wait returns.
Adapter initialization alone, early frame skips, and successful compilation
cannot satisfy this smoke. Failure diagnostics, early exit, missing markers and
more than 1 MiB of output fail it. Build time is bounded at 600 seconds; the
native observation deadline is 15 seconds. The supervisor terminates only its own
child, escalating to kill after two seconds and waiting to reap it. SIGTERM
and Ctrl+C during native observation also take this cleanup path; SIGKILL cannot
be handled. No window lookup, global event injection,
screen capture, user settings changes, or logs/captures are written by the test.

This task launches **only the demo**, never `tokamak-desktop`, so it cannot open
the real Notes datastore. Do not substitute the desktop executable: its actual
`ProjectDirs` location must first be verified inside child-scoped storage
settings. Desktop presentation remains a separate acceptance step.

The complete timing markers establish a completed upstream render/present path,
not confirmed native surface presentation: `Queue.present()` returns unit and
does not establish compositor-visible pixels. They do not establish
visible-pixel correctness, physical mouse/IME, candidate placement, scrolling,
resize/DPI, suspend/resume, surface/device-loss recovery, GPU utilization, frame
rate or input latency. Forced child termination is not evidence of graceful
desktop/backend drain. The unchanged headless behavior suites and physical
foreground gate remain necessary. Diagnostic timings are not a benchmark.

## Headless supervisor checks

Run `python3 packages/render/tests/gpu_smoke_supervision_test.py` to exercise
deadline cleanup, kill/reap escalation, and SIGTERM cancellation of a separate
supervisor with a live child, using real owned non-GUI subprocesses.
These tests emit no fake GPU markers and establish no GPU acceptance.
