"""Prepare a verified public APK for disposable CI; never handle signing keys."""

import base64
import binascii
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile


REPOSITORY = "rbayat2k-art/mission"
APPROVED_PAYLOAD_SHA256 = "2e202cf71bbf18ac1caefa465441175c734d6cea441aa485999f3dc70ca4e60b"
MAX_ENCODED_CHARS = 60_000
MAX_PAYLOAD_BYTES = 45_000


class PreparationError(Exception):
    """A public APK could not be safely prepared."""


def validate_inputs(inputs):
    if not isinstance(inputs, dict):
        raise PreparationError("Missing workflow inputs")
    asset = inputs.get("signed_release_asset_id", "")
    payload = inputs.get("signed_release_apk_base64", "")
    checksum = inputs.get("signed_release_sha256", "")
    if not all(isinstance(value, str) for value in (asset, payload, checksum)):
        raise PreparationError("APK source and SHA-256 inputs must be strings")
    if bool(asset) == bool(payload):
        raise PreparationError("Choose exactly one APK source: asset ID or approved public payload")
    if re.fullmatch(r"[0-9a-fA-F]{64}", checksum) is None:
        raise PreparationError("Invalid or missing SHA-256")
    if asset and re.fullmatch(r"[1-9][0-9]{0,19}", asset) is None:
        raise PreparationError("Invalid numeric asset ID")
    if payload and len(payload) > MAX_ENCODED_CHARS:
        raise PreparationError("Public APK payload exceeds the encoded size limit")
    checksum = checksum.lower()
    if payload and checksum != APPROVED_PAYLOAD_SHA256:
        raise PreparationError("Public payload must identify the specifically approved final APK")
    return asset, payload, checksum


def verify_apk(data, checksum):
    if hashlib.sha256(data).hexdigest() != checksum:
        raise PreparationError("APK SHA-256 mismatch")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            if any(names.count(name) != 1 for name in ("AndroidManifest.xml", "classes.dex")):
                raise PreparationError("APK ZIP must contain its manifest and classes.dex exactly once")
    except zipfile.BadZipFile as error:
        raise PreparationError("APK payload is not a valid ZIP archive") from error
    return data


def decode_payload(payload, checksum):
    if len(payload) > MAX_ENCODED_CHARS:
        raise PreparationError("Public APK payload exceeds the encoded size limit")
    try:
        data = base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error) as error:
        raise PreparationError("Invalid strict base64 APK payload") from error
    if len(data) > MAX_PAYLOAD_BYTES:
        raise PreparationError("Public APK payload exceeds the decoded size limit")
    return verify_apk(data, checksum)


def download_asset(asset, checksum):
    # Asset is strictly numeric and the host/repository are fixed; no shell is used.
    try:
        result = subprocess.run(
            ["gh", "api", "--hostname", "github.com", "-H", "Accept: application/octet-stream",
             f"repos/{REPOSITORY}/releases/assets/{asset}"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PreparationError("Release asset download did not complete") from error
    if result.returncode != 0:
        raise PreparationError("Release asset download failed; check visibility and read-only token access")
    return verify_apk(result.stdout, checksum)


def prepare(event_path, repository, destination=Path("apk/final.apk")):
    if repository != REPOSITORY:
        raise PreparationError("Signed APK verification is restricted to the expected repository")
    try:
        event = json.loads(Path(event_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise PreparationError("Workflow event could not be read") from error
    if not isinstance(event, dict):
        raise PreparationError("Invalid workflow event")
    asset, payload, checksum = validate_inputs(event.get("inputs"))
    data = decode_payload(payload, checksum) if payload else download_asset(asset, checksum)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Never replace an existing APK. All payload validation precedes any output.
    with destination.open("xb") as output:
        output.write(data)
    return len(data)


def main():
    try:
        prepare(os.environ.get("GITHUB_EVENT_PATH", ""), os.environ.get("GITHUB_REPOSITORY", ""))
    except (PreparationError, OSError) as error:
        if isinstance(error, PreparationError):
            print(str(error), file=sys.stderr)
        else:
            print("Verified APK output could not be created", file=sys.stderr)
        return 1
    print("Exact public APK prepared and verified; payload bytes were not logged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
