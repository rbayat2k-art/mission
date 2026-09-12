"""Capture CI UI evidence without mistaking a retained activity for a live app."""

import argparse
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

from capture_ui import CaptureError, PACKAGE_NAME, capture_ui, run_adb


def checked_adb(*arguments):
    result = run_adb(*arguments)
    if result.returncode != 0:
        raise CaptureError("ADB application-state check failed")
    return result.stdout


def require_foreground(activity_dump):
    # Prefer the current/top activity to historical records further down dumpsys.
    # Both ':' (Android 6) and '=' (newer Android) are supported.
    for field in ("topResumedActivity", "mFocusedActivity", "mResumedActivity"):
        records = [line for line in activity_dump.splitlines()
                   if re.match(rf"^[ \t]*{field}\s*[:=]", line)
                   and not re.fullmatch(rf"[ \t]*{field}\s*[:=]\s*null\s*", line)]
        if not records:
            continue
        pattern = (rf"[ \t]*{field}\s*[:=]\s*ActivityRecord\{{[^\s{{}}]+\s+u0\s+"
                   r"ir\.taprasystem\.employee/(?:\.MainActivity|ir\.taprasystem\.employee\.MainActivity)"
                   r"\s+t[0-9]+(?:\s+[^{}]*)?\}\s*")
        if not all(re.fullmatch(pattern, record) for record in records):
            raise CaptureError("TAPRA MainActivity is not the foreground activity for user zero")
        return
    raise CaptureError("Current foreground TAPRA activity evidence is missing")


def require_live_app():
    # Plain ps is available on API 23 too; avoid the newer-only ps -A option.
    processes = checked_adb("shell", "ps")
    pids = [fields[1] for fields in (line.split() for line in processes.splitlines())
            if len(fields) > 2 and fields[1].isdigit() and int(fields[1]) > 0
            and fields[-1] == PACKAGE_NAME]
    if len(pids) != 1:
        raise CaptureError("TAPRA application process is not running or is ambiguous")
    require_foreground(checked_adb("shell", "dumpsys", "activity", "activities"))
    return pids[0]


def require_no_crash():
    lines = checked_adb("logcat", "-d", "-t", "800").splitlines()
    for index, line in enumerate(lines):
        if re.search(r"FATAL EXCEPTION|Fatal signal|ANR in", line):
            if PACKAGE_NAME in "\n".join(lines[index:index + 21]):
                raise CaptureError("TAPRA crash or ANR evidence found after UI capture")


def verify_capture(output, expect):
    original_pid = require_live_app()
    original_status = capture_ui(output)
    # These gates still run after a recovered 137, with no app restart or retry.
    if require_live_app() != original_pid:
        raise CaptureError("TAPRA application restarted during UI capture")
    require_no_crash()
    try:
        root = ET.parse(output).getroot()
    except (OSError, ET.ParseError) as error:
        raise CaptureError("Validated UI evidence could not be read") from error
    text = " ".join(value for node in root.iter("node") for value in node.attrib.values())
    if expect == "battery" and "تنظیم باتری برای ورود الزامی است" not in text:
        raise CaptureError("Required battery-permission gate is missing")
    if expect == "page" and any(message in text for message in (
        "صفحه سامانه بارگذاری نشد", "در حال بازکردن راهکار", "تنظیم باتری برای ورود الزامی است"
    )):
        raise CaptureError("Application remains on an error, loading or battery-gate screen")
    return original_status


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--expect", choices=("battery", "page"), required=True)
    args = parser.parse_args(argv)
    try:
        verify_capture(args.output, args.expect)
    except CaptureError as error:
        print(f"Application UI verification failed: {error}", file=sys.stderr)
        return 1
    print("Fresh UI, live foreground application and crash checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
