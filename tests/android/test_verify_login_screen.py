"""Strict screen policy tests: mocked ADB/OCR and real temporary PNG/XML files."""
import contextlib
import importlib.util
import io
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zlib

SOURCE = Path(__file__).resolve().parents[2] / "scripts/android/verify_login_screen.py"
SPEC = importlib.util.spec_from_file_location("verify_login_screen", SOURCE)
screen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(screen)

def chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)

HEADER = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
PNG = HEADER + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff\xff")) + chunk(b"IEND", b"")
XML = '<hierarchy><node package="ir.taprasystem.employee" class="android.webkit.WebView" /></hierarchy>'
LOGIN = "\n\n".join(screen.LOGIN_LABELS)
FOREGROUND = b"mResumedActivity: ActivityRecord{123 u0 ir.taprasystem.employee/.MainActivity t1}\n"

class VerifyLoginScreenTests(unittest.TestCase):
    def execute(self, *, ocr=LOGIN, png=PNG, xml=XML, fail=None, timeout=None, stale=None, foreground=FOREGROUND, after=FOREGROUND, expected="login"):
        with tempfile.TemporaryDirectory(prefix="tapra-screen-test-") as directory:
            image = Path(directory) / "screen.png"
            hierarchy = Path(directory) / "ui.xml"
            hierarchy.write_text(xml, encoding="utf-8")
            if stale:
                image.with_suffix(stale).write_bytes(PNG)
            commands = []
            def run(arguments, **options):
                commands.append(arguments)
                self.assertEqual(options["timeout"], screen.TIMEOUT_SECONDS)
                self.assertFalse(options["check"])
                self.assertNotIn("shell", options)
                operation = "ocr" if arguments[0] == "tesseract" else "capture" if arguments[1] == "exec-out" else "foreground"
                if timeout == operation:
                    raise subprocess.TimeoutExpired(arguments, options["timeout"])
                if operation == "ocr":
                    self.assertEqual(arguments, ["tesseract", str(image), "stdout", "-l", "fas+eng", "--psm", "11"])
                    self.assertEqual(image.read_bytes(), png)
                    output = ocr.encode("utf-8")
                elif operation == "capture":
                    self.assertEqual(arguments, ["adb", "exec-out", "screencap", "-p"])
                    output = png
                else:
                    output = foreground if len(commands) == 1 else after
                return subprocess.CompletedProcess(arguments, 1 if fail == operation else 0, output, b"")
            with patch.object(screen.subprocess, "run", side_effect=run):
                screen.verify_screen(hierarchy, image, expected)
            self.assertEqual(image.read_bytes(), PNG)
            if expected == "login":
                self.assertEqual(image.with_suffix(".ocr.txt").read_text(encoding="utf-8"), ocr)
                self.assertEqual(len(commands), 4)
            else:
                self.assertFalse(image.with_suffix(".ocr.txt").exists())
                self.assertFalse(any(command[0] == "tesseract" for command in commands))

    def test_empty_webview_needs_independent_fresh_positive_ocr(self):
        self.execute()

    def test_blank_partial_wrong_heading_and_loading_fail(self):
        for text in ("", "راهکار", LOGIN.replace("کارمند", "ادمین"), LOGIN.replace("نام کاربری", ""),
                     LOGIN.replace("رمز عبور", ""), "\n".join(screen.LOGIN_LABELS[:-1]),
                     LOGIN + "\nدر حال بازگردانی صفحه شما…", LOGIN + "\n" + screen.OBSOLETE_HEADING):
            with self.subTest(text=text), self.assertRaises(screen.VerificationError):
                self.execute(ocr=text)

    def test_normalization_is_limited_and_never_fuzzy(self):
        equivalent = LOGIN.replace("ی", "ي").replace("ک", "ك").replace(" ", "  ")
        screen.require_login_text("\n".join("\u200f" + line + "\u202c" for line in equivalent.splitlines()))
        for altered in (LOGIN.replace("ورود", "ورود!"), LOGIN.replace("کارمند", "کارمنذ"), LOGIN[::-1]):
            with self.subTest(text=altered), self.assertRaises(screen.VerificationError):
                screen.require_login_text(altered)

    def test_nonzero_and_timeouts_fail_even_with_valid_outputs(self):
        for policy in ("fail", "timeout"):
            for operation in ("foreground", "capture", "ocr"):
                with self.subTest(policy=policy, operation=operation), self.assertRaises(screen.VerificationError):
                    self.execute(**{policy: operation})

    def test_stale_image_or_ocr_cannot_be_reused(self):
        for suffix in (".png", ".ocr.txt"):
            with self.subTest(suffix=suffix), self.assertRaisesRegex(screen.VerificationError, "Existing"):
                self.execute(stale=suffix)

    def test_malformed_png_and_corrupt_pixels_fail(self):
        for png in (b"", b"not PNG", PNG[:16], PNG[:-12], PNG + b"extra", PNG[:-1] + bytes([PNG[-1] ^ 1])):
            with self.subTest(png=png), self.assertRaises(screen.VerificationError):
                self.execute(png=png)
        for pixels in (b"", b"too-long-image", b"\x05\xff\xff\xff\xff"):
            with self.subTest(pixels=pixels), self.assertRaises(screen.VerificationError):
                screen.validate_png(HEADER + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))

    def test_foreground_required_before_and_after(self):
        wrong = b"mResumedActivity: ActivityRecord{123 com.android.launcher3/.Launcher t1}\n"
        for arguments in ({"foreground": wrong}, {"after": wrong}):
            with self.subTest(arguments=arguments), self.assertRaisesRegex(screen.VerificationError, "foreground"):
                self.execute(**arguments)

    def test_hierarchy_requires_package_complete_xml_and_no_loading(self):
        for xml in ("", "<hierarchy>", '<hierarchy><node package="com.android.launcher3"/></hierarchy>',
                    '<wrong><node package="ir.taprasystem.employee"/></wrong>',
                    '<hierarchy><node package="ir.taprasystem.employee" text="در حال بازگردانی صفحه شما…"/></hierarchy>'):
            with self.subTest(xml=xml), self.assertRaises(screen.VerificationError):
                self.execute(xml=xml)

    def test_obsolete_mode_is_exact_native_rejection_not_login(self):
        self.execute(xml=f'<hierarchy><node package="ir.taprasystem.employee" text="{screen.OBSOLETE_HEADING}"/></hierarchy>', expected="obsolete-webview")
        for text in ("", screen.LOGIN_LABELS[0], screen.OBSOLETE_HEADING + " اشتباه"):
            with self.subTest(text=text), self.assertRaises(screen.VerificationError):
                self.execute(xml=f'<hierarchy><node package="ir.taprasystem.employee" text="{text}"/></hierarchy>', expected="obsolete-webview")

    def test_cli_failure_does_not_print_ocr_content(self):
        errors = io.StringIO()
        with patch.object(screen, "verify_screen", side_effect=screen.VerificationError("Missing required labels")), contextlib.redirect_stderr(errors):
            self.assertEqual(screen.main(["--xml", "ui.xml", "--png", "screen.png", "--expect", "login"]), 1)
        self.assertEqual(errors.getvalue(), "Public screen verification failed: Missing required labels\n")

if __name__ == "__main__":
    unittest.main()
