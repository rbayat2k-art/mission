"""Validate a fresh emulator UI dump, with narrowly scoped exit-137 recovery."""

import argparse
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET


PACKAGE_NAME = "ir.taprasystem.employee"
ADB_TIMEOUT_SECONDS = 30


class CaptureError(RuntimeError):
    """The capture cannot provide independently validated UI evidence."""


def run_adb(*arguments):
    try:
        return subprocess.run(
            ["adb", *arguments],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=ADB_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise CaptureError("ADB UI capture command timed out") from error
    except OSError as error:
        raise CaptureError("ADB UI capture command could not run") from error


def capture_ui(output):
    """Return the original dump status only after validating and saving fresh XML."""
    output = Path(output)
    # Every invocation gets a new emulator path; no existing dump can be reused.
    # These two small files live only as long as the disposable CI emulator.
    remote = f"/sdcard/tapra-ui-{uuid.uuid4().hex}.xml"
    dumped = run_adb("shell", "uiautomator", "dump", remote)
    if dumped.returncode not in (0, 137):
        raise CaptureError(f"UI dump failed with unexpected status {dumped.returncode}")
    marker = f"UI hierchary dumped to: {remote}"
    if marker not in (line.strip() for line in dumped.stdout.splitlines()):
        raise CaptureError("UI dump did not report completion for its fresh path")

    try:
        # Pull into a new local directory, never into a potentially stale output.
        with tempfile.TemporaryDirectory(prefix="tapra-ui-", dir=output.parent) as temporary:
            fresh = Path(temporary) / "hierarchy.xml"
            pulled = run_adb("pull", remote, str(fresh))
            if pulled.returncode != 0:
                raise CaptureError(f"UI dump pull failed with status {pulled.returncode}")
            try:
                hierarchy = ET.parse(fresh).getroot()
            except (OSError, ET.ParseError) as error:
                raise CaptureError("Fresh UI dump is missing or is not complete XML") from error
            if hierarchy.tag != "hierarchy":
                raise CaptureError("Fresh UI dump does not have a hierarchy root")
            if not any(node.get("package") == PACKAGE_NAME for node in hierarchy.iter("node")):
                raise CaptureError("Fresh UI dump contains no TAPRA package nodes")
            fresh.replace(output)
    except OSError as error:
        raise CaptureError("Validated UI dump could not be saved") from error

    if dumped.returncode == 137:
        print(
            "::warning::Recovered UI capture tooling status 137 using a completed, "
            "fresh, parsed TAPRA hierarchy; the dump command did not exit successfully. "
            "Application assertions must still pass.",
            file=sys.stderr,
        )
    return dumped.returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Destination for independently validated XML")
    arguments = parser.parse_args(argv)
    try:
        capture_ui(arguments.output)
    except CaptureError as error:
        print(f"UI capture failed: {error}", file=sys.stderr)
        return 1
    print("Fresh TAPRA UI hierarchy validated; continue application assertions.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
