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


def diagnostic_adb(*arguments):
    """Collect bounded evidence without allowing a diagnostic failure to hide the original one."""
    try:
        result = run_adb(*arguments)
    except CaptureError:
        return "<unavailable>"
    return result.stdout if result.returncode == 0 else "<unavailable>"


def _diagnostic_matches(text, pattern, maximum=100):
    return [line.strip() for line in text.splitlines()
            if re.search(pattern, line, re.IGNORECASE)][:maximum]


def _redact_diagnostic(line):
    line = re.sub(r"(?i)https?://\S+", "<URL>", line)
    line = re.sub(r"(?i)(authorization|cookie|password|passwd|token|session|secret)(\s*[:=]\s*).+",
                  r"\1\2<REDACTED>", line)
    line = re.sub(r"(?<![\w.])-?\d{1,3}\.\d{4,}(?![\w.])", "<LOCATION_OR_DECIMAL>", line)
    return line[:500]


def _foreground_components(activity_dump):
    result = []
    for field in ("topResumedActivity", "mFocusedActivity", "mResumedActivity", "mCurrentFocus", "mFocusedApp"):
        for line in activity_dump.splitlines():
            if not re.match(rf"^[ \t]*{field}\s*[:=]", line):
                continue
            match = re.search(r"\bu\d+\s+([A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+)", line)
            if match:
                result.append((field, match.group(1)))
    return result


def collect_foreground_diagnostics(output, initial_activity="", initial_process="", reason=""):
    """Save sanitized Android state if TAPRA is not the current foreground activity."""
    api = diagnostic_adb("shell", "getprop", "ro.build.version.sdk").strip() or "unknown"
    activity = diagnostic_adb("shell", "dumpsys", "activity", "activities") or initial_activity
    activity_top = diagnostic_adb("shell", "dumpsys", "activity", "top")
    windows = diagnostic_adb("shell", "dumpsys", "window", "windows")
    package = diagnostic_adb("shell", "dumpsys", "package", PACKAGE_NAME)
    pidof = diagnostic_adb("shell", "pidof", PACKAGE_NAME).strip()
    process = diagnostic_adb("shell", "ps") or initial_process
    logcat = diagnostic_adb("logcat", "-d", "-t", "1200")

    pids = [fields[1] for fields in (line.split() for line in process.splitlines())
            if len(fields) > 2 and fields[1].isdigit() and int(fields[1]) > 0
            and fields[-1] == PACKAGE_NAME]
    components = _foreground_components(activity + "\n" + windows)
    component_text = ", ".join(f"{field}={name}" for field, name in components) or "none"
    system_markers = ("permissioncontroller", "packageinstaller", "settings/", "systemui/", "launcher/")
    system_activity = any(any(marker in name.lower() for marker in system_markers)
                          for _, name in components)
    crashes = _diagnostic_matches(logcat, r"FATAL EXCEPTION|Fatal signal|ANR in")
    relevant_logs = _diagnostic_matches(
        logcat, rf"{re.escape(PACKAGE_NAME)}|AndroidRuntime|ActivityTaskManager|ActivityManager|PermissionController|permissioncontroller", 180)
    lifecycle = _diagnostic_matches(activity + "\n" + activity_top,
        r"MainActivity.*(pause|stop|finishing|destroy)|(?:pause|stop|finishing|destroy).*MainActivity|mLastPausedActivity|mStoppingActivities")
    sections = [
        "TAPRA emulator foreground diagnostics (sanitized)",
        f"Android API level: {api}",
        f"Foreground assertion detail: {reason or '<not provided>'}",
        f"Current foreground activity fields: {component_text}",
        f"System/settings/permission activity detected: {'yes' if system_activity else 'no'}",
        f"TAPRA process alive: {'yes' if pids or pidof else 'no'}",
        f"TAPRA PID evidence: {', '.join(pids) if pids else (pidof or 'none')}",
        f"Crash/ANR evidence: {'yes' if crashes else 'no'}",
        "MainActivity pause/stop lifecycle clues:", *(lifecycle or ["<none>"]),
        "dumpsys activity activities:", *(_diagnostic_matches(activity,
            r"topResumedActivity|mFocusedActivity|mResumedActivity|MainActivity|permissioncontroller|packageinstaller|settings/|launcher/|mLastPausedActivity|mStoppingActivities") or ["<none>"]),
        "dumpsys activity top:", *(_diagnostic_matches(activity_top,
            r"ACTIVITY|TASK|MainActivity|Resumed|Paused|Stopped|Stopping|Finishing|permissioncontroller|packageinstaller|settings/|launcher/") or ["<none>"]),
        "dumpsys window windows:", *(_diagnostic_matches(windows,
            r"mCurrentFocus|mFocusedApp|Window\{|MainActivity|permissioncontroller|packageinstaller|settings/|launcher/") or ["<none>"]),
        "dumpsys package ir.taprasystem.employee:", *(_diagnostic_matches(package,
            r"Package \[|userId=|versionCode=|versionName=|requested permissions:|install permissions:|runtime permissions:|android\.permission\.(ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|POST_NOTIFICATIONS)|granted=", 80) or ["<none>"]),
        "Relevant recent logcat:", *(relevant_logs or ["<none>"]),
        "Crash/ANR log lines:", *(crashes or ["<none>"]),
    ]
    evidence = Path(output).with_suffix(".foreground-diagnostics.txt")
    try:
        evidence.write_text("\n".join(_redact_diagnostic(line) for line in sections) + "\n", encoding="utf-8")
    except OSError:
        evidence = None
    safe_components = re.sub(r"[^A-Za-z0-9_.$/,:=-]", "?", component_text)[:160]
    safe_reason = re.sub(r"[^A-Za-z0-9_.$/,:={}()\[\]+#? -]", "?", _redact_diagnostic(reason))[:320]
    summary = (f"API {api}; process {'alive' if pids or pidof else 'not alive'}; "
               f"system activity {'present' if system_activity else 'not detected'}; "
               f"crash/ANR {'detected' if crashes else 'not detected'}; foreground={safe_components}; "
               f"assertion={safe_reason}")
    return evidence, summary


def require_foreground(activity_dump):
    # Prefer the current/top activity to historical records further down dumpsys.
    # Both ':' (Android 6) and '=' (newer Android) are supported.
    for field in ("topResumedActivity", "mFocusedActivity", "mResumedActivity"):
        records = [line for line in activity_dump.splitlines()
                   if re.match(rf"^[ \t]*{field}\s*[:=]", line)
                   and not re.fullmatch(rf"[ \t]*{field}\s*[:=]\s*null\s*", line)]
        if not records:
            continue
        pattern = (rf"^[ \t]*{field}\s*[:=].*\bu0\s+"
                   r"ir\.taprasystem\.employee/(?:\.MainActivity|ir\.taprasystem\.employee\.MainActivity)"
                   r"(?=[}\s,]|$)")
        mismatches = [record for record in records if not re.search(pattern, record)]
        if mismatches:
            detail = " | ".join(_redact_diagnostic(record) for record in mismatches)[:350]
            raise CaptureError("TAPRA MainActivity is not the foreground activity for user zero; " + detail)
        return
    raise CaptureError("Current foreground TAPRA activity evidence is missing")


def require_live_app(diagnostic_output=None):
    # Plain ps is available on API 23 too; avoid the newer-only ps -A option.
    processes = checked_adb("shell", "ps")
    pids = [fields[1] for fields in (line.split() for line in processes.splitlines())
            if len(fields) > 2 and fields[1].isdigit() and int(fields[1]) > 0
            and fields[-1] == PACKAGE_NAME]
    activity_dump = checked_adb("shell", "dumpsys", "activity", "activities")
    foreground_error = None
    try:
        require_foreground(activity_dump)
    except CaptureError as error:
        foreground_error = error
    if len(pids) != 1 or foreground_error:
        reason = "TAPRA application process is not running or is ambiguous" if len(pids) != 1 else str(foreground_error)
        if diagnostic_output is not None:
            evidence, summary = collect_foreground_diagnostics(
                diagnostic_output, activity_dump, processes, str(foreground_error or "process state mismatch"))
            evidence_name = evidence.name if evidence else "unavailable"
            print(f"::error title=Android foreground diagnosis::{summary}; evidence={evidence_name}", file=sys.stderr)
            if evidence:
                reason += f"; diagnostics saved as {evidence_name}"
        raise CaptureError(reason)
    return pids[0]


def require_no_crash():
    lines = checked_adb("logcat", "-d", "-t", "800").splitlines()
    for index, line in enumerate(lines):
        if re.search(r"FATAL EXCEPTION|Fatal signal|ANR in", line):
            if PACKAGE_NAME in "\n".join(lines[index:index + 21]):
                raise CaptureError("TAPRA crash or ANR evidence found after UI capture")


def verify_capture(output, expect):
    output = Path(output)
    original_pid = require_live_app(output)
    original_status = capture_ui(output)
    # These gates still run after a recovered 137, with no app restart or retry.
    if require_live_app(output) != original_pid:
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
    parser.add_argument("--expect", choices=("battery", "page"))
    parser.add_argument("--diagnostics-only", action="store_true",
                        help="write sanitized current emulator state after another CI command fails")
    args = parser.parse_args(argv)
    try:
        if args.diagnostics_only:
            evidence, summary = collect_foreground_diagnostics(args.output)
            evidence_name = evidence.name if evidence else "unavailable"
            print(f"::error title=Android emulator state::{summary}; evidence={evidence_name}", file=sys.stderr)
            return 0 if evidence else 1
        if not args.expect:
            parser.error("--expect is required unless --diagnostics-only is used")
        verify_capture(args.output, args.expect)
    except CaptureError as error:
        print(f"Application UI verification failed: {error}", file=sys.stderr)
        return 1
    print("Fresh UI, live foreground application and crash checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
