"""Minimal real dumpsys shapes; malformed or ambiguous identities fail closed."""
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "scripts/android/package_identity.py"
SPEC = importlib.util.spec_from_file_location("package_identity", SOURCE)
identity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(identity)


class PackageIdentityTests(unittest.TestCase):
    def test_old_userid_and_api35_appid_extract_same_identity(self):
        for field in ("userId", "appId"):
            fixture = f"Permissions:\n    uid=10148 gids=[]\nPackages:\n  Package [ir.taprasystem.employee] (395c632):\n    {field}=10148\n    versionCode=23 minSdk=23 targetSdk=35\n"
            with self.subTest(field=field):
                self.assertEqual(identity.extract_identity(fixture, "0\r\n"), "10148")

    def test_missing_multiple_and_malformed_fields_fail(self):
        for fixture in ("", "uid=10148", "other userId=10148", "userId=10148\nappId=10148",
                        "appId=10148\nappId=10148", "appId=10148\nuserId=bad", "userId=",
                        "appId=abc", "appId=+10148", "appId=-1", "appId=0", "appId=01",
                        "appId=10148 trailing", "appId=10148x", "appId=۱۰۱۴۸", "appId =10148"):
            with self.subTest(fixture=fixture), self.assertRaises(ValueError):
                identity.extract_identity(fixture, "0")

    def test_nonzero_missing_or_ambiguous_current_android_user_fails(self):
        for user in ("", "10", "0\n10", "User 0", "00", "۰"):
            with self.subTest(user=user), self.assertRaises(ValueError):
                identity.extract_identity("appId=10148", user)

    def test_cli_outputs_only_identity_or_nonzero(self):
        with tempfile.TemporaryDirectory(prefix="tapra-identity-test-") as directory:
            package = Path(directory) / "package.txt"
            user = Path(directory) / "user.txt"
            package.write_text("    appId=10148\n", encoding="utf-8")
            user.write_text("0\n", encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(identity.main([str(package), str(user)]), 0)
            self.assertEqual(output.getvalue(), "10148\n")
            package.write_text("appId=bad\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(identity.main([str(package), str(user)]), 1)


if __name__ == "__main__":
    unittest.main()
