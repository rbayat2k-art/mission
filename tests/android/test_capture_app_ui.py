"""Run actual capture/state policy with synthetic ADB, never a production device."""

import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "android"))
import capture_app_ui as app
import capture_ui as capture


FOREGROUND = "  mResumedActivity: ActivityRecord{abc u0 ir.taprasystem.employee/.MainActivity t42}"
PROCESS = "USER PID PPID VSIZE RSS WCHAN PC NAME\nu0_a75 1234 100 1 2 0 0 ir.taprasystem.employee\n"
LOGIN = "ورود به پنل کارمند"


class CaptureAppUiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tapra-app-ui-test-")
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name) / "ui.xml"
        self.commands = []

    def adb(self, *, status=137, post_process=PROCESS, post_activity=FOREGROUND,
            logcat="", text=LOGIN, failed_command=None):
        process_reads = 0
        activity_reads = 0

        def run(command, **options):
            nonlocal process_reads, activity_reads
            self.commands.append(command)
            self.assertEqual(options["timeout"], 30)
            self.assertNotIn("shell", options)
            args = command[1:]
            stdout = ""
            result_status = 0
            if args == ["shell", "ps"]:
                process_reads += 1
                stdout = PROCESS if process_reads == 1 else post_process
            elif args == ["shell", "dumpsys", "activity", "activities"]:
                activity_reads += 1
                stdout = FOREGROUND if activity_reads == 1 else post_activity
            elif args[:3] == ["shell", "uiautomator", "dump"]:
                stdout = f"UI hierchary dumped to: {args[3]}\n"
                result_status = status
            elif args[0] == "pull":
                Path(args[2]).write_text(
                    f'<hierarchy><node package="{app.PACKAGE_NAME}" text="{text}"/></hierarchy>',
                    encoding="utf-8",
                )
            elif args == ["logcat", "-d", "-t", "800"]:
                stdout = logcat
            else:
                self.fail(f"Unexpected ADB command: {args}")
            if args == failed_command:
                result_status = 1
            return subprocess.CompletedProcess(command, result_status, stdout, "")

        return patch.object(capture.subprocess, "run", side_effect=run)

    def test_zero_and_recovered_137_run_all_application_gates(self):
        for status in (0, 137):
            self.commands = []
            with self.subTest(status=status), self.adb(status=status), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(app.verify_capture(self.output, "page"), status)
            self.assertEqual(sum(command[1:3] == ["shell", "ps"] for command in self.commands), 2)
            self.assertEqual(self.commands[-1][1:], ["logcat", "-d", "-t", "800"])
            self.assertEqual(sum(command[1:4] == ["shell", "uiautomator", "dump"] for command in self.commands), 1)
            self.assertFalse(any("am" in command or "-c" in command for command in self.commands))

    def test_valid_137_cannot_hide_a_dead_process(self):
        with self.adb(post_process="USER PID NAME\nu0_a75 12 ir.taprasystem.employee:worker"), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(capture.CaptureError, "not running"):
                app.verify_capture(self.output, "page")

    def test_valid_137_cannot_hide_a_restarted_process_without_crash_logs(self):
        with self.adb(post_process=PROCESS.replace("1234", "5678")), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(capture.CaptureError, "restarted during"):
                app.verify_capture(self.output, "page")

    def test_valid_137_cannot_hide_foreground_loss_or_retained_activity(self):
        for activity in (
            "Hist #0: ActivityRecord{abc u0 ir.taprasystem.employee/.MainActivity t42}",
            "topResumedActivity=ActivityRecord{z u0 com.android.launcher/.Launcher t1}\n" + FOREGROUND,
        ):
            with self.subTest(activity=activity), self.adb(post_activity=activity), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(capture.CaptureError):
                    app.verify_capture(self.output, "page")

    def test_valid_137_cannot_hide_java_native_crash_or_anr(self):
        for marker in ("FATAL EXCEPTION: main", "Fatal signal 11", "ANR in ir.taprasystem.employee"):
            with self.subTest(marker=marker), self.adb(logcat=marker + "\nProcess: ir.taprasystem.employee"), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(capture.CaptureError, "crash or ANR"):
                    app.verify_capture(self.output, "page")

    def test_battery_and_error_screen_assertions_remain_required(self):
        for expect, text in (("battery", LOGIN), ("page", "در حال بازکردن راهکار"),
                             ("page", "صفحه سامانه بارگذاری نشد"), ("page", "تنظیم باتری برای ورود الزامی است")):
            with self.subTest(expect=expect, text=text), self.adb(text=text), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(capture.CaptureError):
                    app.verify_capture(self.output, expect)
        with self.adb(text="تنظیم باتری برای ورود الزامی است"), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(app.verify_capture(self.output, "battery"), 137)

    def test_state_command_failures_do_not_pass(self):
        for command in (["shell", "ps"], ["shell", "dumpsys", "activity", "activities"], ["logcat", "-d", "-t", "800"]):
            with self.subTest(command=command), self.adb(failed_command=command), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(capture.CaptureError, "state check failed"):
                    app.verify_capture(self.output, "page")

    def test_foreground_formats_on_old_and_new_android(self):
        for field, separator in (("mFocusedActivity", ":"), ("mResumedActivity", ":"), ("topResumedActivity", "=")):
            for component in (".MainActivity", "ir.taprasystem.employee.MainActivity"):
                app.require_foreground(f"  {field}{separator} ActivityRecord{{abc u0 ir.taprasystem.employee/{component} t1}}")
        app.require_foreground("topResumedActivity=null\n" + FOREGROUND)

    def test_ambiguous_wrong_user_and_similar_package_are_rejected(self):
        for text in ("", "mResumedActivity=null", FOREGROUND.replace("u0", "u10"),
                     FOREGROUND.replace("employee/", "employee.other/"),
                     FOREGROUND + "\n" + FOREGROUND.replace("employee/", "other/")):
            with self.subTest(text=text), self.assertRaises(capture.CaptureError):
                app.require_foreground(text)

    def test_cli_returns_failure_without_printing_application_data(self):
        errors = io.StringIO()
        with self.adb(post_process="PRIVATE SENTINEL"), contextlib.redirect_stderr(errors):
            self.assertEqual(app.main([str(self.output), "--expect", "page"]), 1)
        self.assertNotIn("PRIVATE SENTINEL", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
