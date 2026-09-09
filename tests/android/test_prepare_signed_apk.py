"""Exercise public APK transport without real keys, tokens, or network access."""

import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile


MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts/android/prepare_signed_apk.py"
SPEC = importlib.util.spec_from_file_location("prepare_signed_apk", MODULE_PATH)
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


def apk_bytes(names=("AndroidManifest.xml", "classes.dex")):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name in names:
            archive.writestr(name, b"test-only bytes")
    return output.getvalue()


class SignedApkPreparationTests(unittest.TestCase):
    def setUp(self):
        self.data = apk_bytes()
        self.sha = hashlib.sha256(self.data).hexdigest()
        self.payload = base64.b64encode(self.data).decode("ascii")

    def inputs(self, **changes):
        values = {"signed_release_apk_base64": self.payload, "signed_release_sha256": self.sha}
        values.update(changes)
        return values

    def test_production_payload_is_pinned_and_bounded(self):
        self.assertEqual(policy.APPROVED_PAYLOAD_SHA256, "2f4b707a78b7157f6577b77541ad6c2f923bfa67a060ab4d5ad866acc54b04ac")
        self.assertEqual(policy.MAX_ENCODED_CHARS, 64_000)
        self.assertEqual(policy.MAX_PAYLOAD_BYTES, 48_000)
        with self.assertRaisesRegex(policy.PreparationError, "specifically approved"):
            policy.validate_inputs(self.inputs())

    def test_exactly_one_source_and_required_checksum(self):
        with patch.object(policy, "APPROVED_PAYLOAD_SHA256", self.sha):
            for values in [self.inputs(signed_release_asset_id="123"), {}, self.inputs(signed_release_apk_base64=""),
                           self.inputs(signed_release_sha256=""), self.inputs(signed_release_sha256="g" * 64),
                           self.inputs(signed_release_sha256=123), self.inputs(signed_release_apk_base64=None)]:
                with self.subTest(values=list(values)):
                    with self.assertRaises(policy.PreparationError):
                        policy.validate_inputs(values)

    def test_asset_id_is_strictly_numeric(self):
        for asset in ["0", "01", "1\n", "1; echo unsafe", "../123", "1" * 21]:
            with self.subTest(asset=asset), self.assertRaises(policy.PreparationError):
                policy.validate_inputs(self.inputs(signed_release_apk_base64="", signed_release_asset_id=asset))
        self.assertEqual(policy.validate_inputs(self.inputs(signed_release_apk_base64="", signed_release_asset_id="123"))[0], "123")

    def test_base64_rejects_invalid_characters_whitespace_and_padding(self):
        for payload in ["%%%", self.payload + "\n", self.payload + "!", "AA=", "\u2603"]:
            with self.subTest(payload_length=len(payload)), self.assertRaises(policy.PreparationError):
                policy.decode_payload(payload, self.sha)

    def test_oversize_encoded_and_decoded_payloads_rejected(self):
        with self.assertRaisesRegex(policy.PreparationError, "encoded size"):
            policy.decode_payload("A" * 64_001, self.sha)
        oversized = base64.b64encode(b"A" * 48_001).decode("ascii")
        with patch.object(policy, "MAX_ENCODED_CHARS", len(oversized)):
            with self.assertRaisesRegex(policy.PreparationError, "decoded size"):
                policy.decode_payload(oversized, self.sha)

    def test_checksum_mismatch_rejected(self):
        with self.assertRaisesRegex(policy.PreparationError, "SHA-256 mismatch"):
            policy.decode_payload(self.payload, "0" * 64)

    def test_not_zip_and_missing_apk_entries_rejected(self):
        for data in [b"not an APK", apk_bytes(("classes.dex",)), apk_bytes(("AndroidManifest.xml",)), apk_bytes(("other",))]:
            with self.subTest(size=len(data)), self.assertRaises(policy.PreparationError):
                policy.decode_payload(base64.b64encode(data).decode("ascii"), hashlib.sha256(data).hexdigest())

    def test_event_payload_is_written_byte_for_byte_without_downloading(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(policy, "APPROVED_PAYLOAD_SHA256", self.sha), patch.object(policy, "download_asset") as download:
            directory = Path(temporary)
            event = directory / "event.json"
            event.write_text(json.dumps({"inputs": self.inputs()}), encoding="utf-8")
            output = directory / "apk/final.apk"
            self.assertEqual(policy.prepare(event, policy.REPOSITORY, output), len(self.data))
            self.assertEqual(output.read_bytes(), self.data)
            download.assert_not_called()
            with self.assertRaises(FileExistsError):
                policy.prepare(event, policy.REPOSITORY, output)
            self.assertEqual(output.read_bytes(), self.data)

    def test_rejected_input_creates_no_apk(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            event = directory / "event.json"
            event.write_text(json.dumps({"inputs": self.inputs(signed_release_asset_id="123")}), encoding="utf-8")
            output = directory / "apk/final.apk"
            with self.assertRaises(policy.PreparationError):
                policy.prepare(event, policy.REPOSITORY, output)
            self.assertFalse(output.exists())
            with self.assertRaises(policy.PreparationError):
                policy.prepare(event, "other/repository", output)

    def test_asset_download_uses_fixed_host_endpoint_without_shell_and_verifies_bytes(self):
        result = subprocess.CompletedProcess([], 0, stdout=self.data, stderr=b"")
        with patch.object(policy.subprocess, "run", return_value=result) as run:
            self.assertEqual(policy.download_asset("123", self.sha), self.data)
            self.assertEqual(run.call_args.args[0], ["gh", "api", "--hostname", "github.com", "-H", "Accept: application/octet-stream", "repos/rbayat2k-art/mission/releases/assets/123"])
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_asset_errors_never_echo_response_or_token(self):
        result = subprocess.CompletedProcess([], 1, stdout=b"sensitive response", stderr=b"secret-token")
        with patch.object(policy.subprocess, "run", return_value=result):
            with self.assertRaises(policy.PreparationError) as error:
                policy.download_asset("123", self.sha)
            self.assertNotIn("secret-token", str(error.exception))
            self.assertNotIn("sensitive response", str(error.exception))


if __name__ == "__main__":
    unittest.main()
