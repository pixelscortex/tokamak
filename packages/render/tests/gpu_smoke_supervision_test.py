"""Headless supervision checks, NOT mock-adapter GPU acceptance.

Run: python3 packages/render/tests/gpu_smoke_supervision_test.py
These use real owned subprocesses without opening windows or emitting GPU
markers. The separate opt-in task must still execute the production GPU demo.
"""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "gpu_smoke", Path(__file__).with_name("gpu-smoke.py")
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


@unittest.skipUnless(sys.platform in ("darwin", "linux"), "native POSIX pipe supervision")
class Supervision(unittest.TestCase):
    def test_sigterm_to_supervisor_reaps_its_live_child(self):
        # Run a real independent supervisor, not a mocked signal handler. Its
        # child announces its PID through observe's normal output forwarding.
        with tempfile.TemporaryDirectory() as scratch:
            executable = Path(scratch) / "announcing-child"
            executable.write_text("#!/bin/sh\necho CHILD_READY $$\nexec sleep 60\n")
            executable.chmod(0o700)
            supervisor = subprocess.Popen(
                [
                    sys.executable, "-B", "-u", "-c",
                    "import importlib.util,sys; from pathlib import Path; "
                    "s=importlib.util.spec_from_file_location('smoke',sys.argv[1]); "
                    "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                    "m.observe(Path(sys.argv[2]),deadline=60)",
                    str(Path(smoke.__file__).resolve()), str(executable),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            child_pid = None
            child_reaped = False
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(supervisor.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(timeout=5), "supervisor did not start")
                    ready = supervisor.stdout.readline().decode()
                self.assertTrue(ready.startswith("CHILD_READY "), ready)
                child_pid = int(ready.split()[1])
                supervisor.terminate()
                output = supervisor.communicate(timeout=5)[0].decode()
                child_reaped = f"Reaped own demo child {child_pid}" in output
                self.assertNotEqual(supervisor.returncode, 0)
                self.assertIn("cancelled by SIGTERM", output)
                self.assertTrue(child_reaped, output)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if supervisor.poll() is None:
                    supervisor.kill()
                    supervisor.wait(timeout=2)
                supervisor.stdout.close()
                # Failure-only leak containment targets only the announced PID
                # created by this test, never process names or unrelated groups.
                if child_pid is not None and not child_reaped:
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_missing_marker_hits_deadline_and_reaps_owned_child(self):
        children = []
        real_popen = subprocess.Popen

        def start(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child

        with tempfile.TemporaryDirectory() as scratch:
            executable = Path(scratch) / "silent-child"
            executable.write_text("#!/bin/sh\nexec sleep 60\n")
            executable.chmod(0o700)
            started = time.monotonic()
            with patch.object(smoke.subprocess, "Popen", side_effect=start):
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(RuntimeError, "deadline"):
                        smoke.observe(executable, deadline=0.2)
            self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertTrue(children[0].stdout.closed)

    def test_uncooperative_child_is_killed_and_reaped(self):
        child = subprocess.Popen(
            [
                sys.executable, "-u", "-c",
                "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                "print('ready', flush=True); time.sleep(60)",
            ],
            stdout=subprocess.PIPE,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=3), "child did not initialize")
                self.assertEqual(child.stdout.readline(), b"ready\n")
            started = time.monotonic()
            smoke.stop_and_reap(child)
            self.assertLess(time.monotonic() - started, 5)
            self.assertIsNotNone(child.returncode)
            self.assertEqual(child.returncode, -signal.SIGKILL)
            # Reaping is idempotent for a child that has already exited.
            smoke.stop_and_reap(child)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=2)
            child.stdout.close()


if __name__ == "__main__":
    unittest.main()
