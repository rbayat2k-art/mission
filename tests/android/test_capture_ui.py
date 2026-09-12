"""Exercise actual capture policy with mocked ADB and real temporary XML files."""

import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[2] / "scripts" / "android" / "capture_ui.py"
SPEC = importlib.util.spec_from_file_location("capture_ui", SOURCE)
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)

VALID_XML = '<hierarchy rotation="0"><node package="ir.taprasystem.employee" text="ورود به پنل کارمند" /></hierarchy>'


class CaptureUiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tapra-capture-test-")
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name) / "tapra-ui.xml"
        self.commands = []

    def adb(self, *, status=0, xml=VALID_XML, marker=True, pull_status=0, timeout=None):
        def run(command, **options):
            self.commands.append(command)
            self.assertEqual(command[0], "adb")
            self.assertEqual(options["timeout"], capture.ADB_TIMEOUT_SECONDS)
            self.assertFalse(options["check"])
            self.assertNotIn("shell", options)
            if command[1:4] == ["shell", "uiautomator", "dump"]:
                if timeout == "dump":
                    raise subprocess.TimeoutExpired(command, options["timeout"])
                remote = command[4]
                self.assertRegex(remote, r"^/sdcard/tapra-ui-[0-9a-f]{32}\.xml$")
                stdout = f"UI hierchary dumped to: {remote}\n" if marker else ""
                return subprocess.CompletedProcess(command, status, stdout, "")
            self.assertEqual(command[1], "pull")
            self.assertEqual(command[2], self.commands[-2][4])
            if timeout == "pull":
                raise subprocess.TimeoutExpired(command, options["timeout"])
            fresh = Path(command[3])
            self.assertFalse(fresh.exists(), "pull must never reuse existing local XML")
            self.assertNotEqual(fresh, self.output)
            if xml is not None:
                fresh.write_text(xml, encoding="utf-8")
            return subprocess.CompletedProcess(command, pull_status, "", "")
        return patch.object(capture.subprocess, "run", side_effect=run)

    def assert_rejected(self, **options):
        errors = io.StringIO()
        with self.adb(**options), contextlib.redirect_stderr(errors):
            with self.assertRaises(capture.CaptureError):
                capture.capture_ui(self.output)
        self.assertFalse(self.output.exists())
        self.assertNotIn("Recovered", errors.getvalue())

    def test_normal_completed_dump_is_validated(self):
        errors = io.StringIO()
        with self.adb(), contextlib.redirect_stderr(errors):
            self.assertEqual(capture.capture_ui(self.output), 0)
        self.assertEqual(self.output.read_text(encoding="utf-8"), VALID_XML)
        self.assertEqual(errors.getvalue(), "")

    def test_137_recovery_requires_valid_evidence_and_warns(self):
        errors = io.StringIO()
        with self.adb(status=137), contextlib.redirect_stderr(errors):
            self.assertEqual(capture.capture_ui(self.output), 137)
        self.assertEqual(self.output.read_text(encoding="utf-8"), VALID_XML)
        self.assertIn("Recovered UI capture tooling status 137", errors.getvalue())
        self.assertIn("did not exit successfully", errors.getvalue())
        self.assertIn("Application assertions must still pass", errors.getvalue())

    def test_unexpected_nonzero_fails_even_when_valid_xml_is_available(self):
        for status in (1, 2, 124, -9):
            with self.subTest(status=status):
                self.commands = []
                self.assert_rejected(status=status)
                self.assertEqual(len(self.commands), 1, "unexpected status must stop before pull")

    def test_missing_malformed_empty_and_foreign_xml_fail_for_0_and_137(self):
        for status in (0, 137):
            for xml in (
                None,
                "",
                '<hierarchy><node package="ir.taprasystem.employee"/>',
                VALID_XML + "trailing garbage",
                '<wrong><node package="ir.taprasystem.employee"/></wrong>',
                '<hierarchy/>',
                '<hierarchy><node package="com.android.launcher3"/></hierarchy>',
                '<hierarchy><node text="ir.taprasystem.employee"/></hierarchy>',
            ):
                with self.subTest(status=status, xml=xml):
                    self.assert_rejected(status=status, xml=xml)

    def test_missing_completion_marker_fails_for_0_and_137(self):
        for status in (0, 137):
            with self.subTest(status=status):
                self.commands = []
                self.assert_rejected(status=status, marker=False)
                self.assertEqual(len(self.commands), 1)

    def test_completion_marker_for_a_different_remote_path_fails(self):
        result = subprocess.CompletedProcess(
            ["adb"], 137, "UI hierchary dumped to: /sdcard/old.xml\n", ""
        )
        with patch.object(capture.subprocess, "run", return_value=result):
            with self.assertRaises(capture.CaptureError):
                capture.capture_ui(self.output)
        self.assertFalse(self.output.exists())

    def test_pull_failure_rejects_even_a_valid_file(self):
        for status in (0, 137):
            with self.subTest(status=status):
                self.assert_rejected(status=status, pull_status=1)

    def test_timeouts_fail_closed(self):
        for timeout in ("dump", "pull"):
            for status in (0, 137):
                with self.subTest(timeout=timeout, status=status):
                    self.assert_rejected(status=status, timeout=timeout)

    def test_adb_unavailable_fails_closed(self):
        with patch.object(capture.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(capture.CaptureError, "could not run"):
                capture.capture_ui(self.output)

    def test_existing_local_xml_cannot_rescue_missing_fresh_dump(self):
        self.output.write_text(VALID_XML, encoding="utf-8")
        with self.adb(status=137, xml=None):
            with self.assertRaises(capture.CaptureError):
                capture.capture_ui(self.output)
        self.assertEqual(self.output.read_text(encoding="utf-8"), VALID_XML)

    def test_each_capture_uses_a_unique_remote_path_without_deletion(self):
        with self.adb():
            capture.capture_ui(self.output)
            capture.capture_ui(self.output)
        self.assertEqual(len(self.commands), 4)
        self.assertNotEqual(self.commands[0][4], self.commands[2][4])
        self.assertEqual([command[1] for command in self.commands], ["shell", "pull", "shell", "pull"])

    def test_cli_exits_zero_only_after_validating_recovered_evidence(self):
        with self.adb(status=137), contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(capture.main([str(self.output)]), 0)
        self.assertEqual(self.output.read_text(encoding="utf-8"), VALID_XML)

    def test_cli_failure_returns_nonzero(self):
        errors = io.StringIO()
        with self.adb(status=137, xml=None), contextlib.redirect_stderr(errors):
            self.assertEqual(capture.main([str(self.output)]), 1)
        self.assertIn("UI capture failed", errors.getvalue())
        self.assertNotIn("Recovered", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
