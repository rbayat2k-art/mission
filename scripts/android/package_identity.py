"""Read one package identity across Android dumpsys formats, only for user zero."""
import argparse
from pathlib import Path
import re
import sys


def require_foreground_user_zero(activity_dump):
    # Android 6 has no `am get-current-user`. ActivityRecord exposes the user
    # owning the foreground app on every supported API; u0 makes appId == UID.
    for field in ("topResumedActivity", "mFocusedActivity", "mResumedActivity"):
        records = [line for line in activity_dump.splitlines()
                   if re.match(rf"^[ \t]*{field}\s*[:=]", line)
                   and not re.fullmatch(rf"[ \t]*{field}\s*[:=]\s*null\s*", line)]
        if not records:
            continue
        pattern = (rf"[ \t]*{field}\s*[:=]\s*ActivityRecord\{{[^\s{{}}]+\s+u(0|[1-9][0-9]*)\s+"
                   r"ir\.taprasystem\.employee/(?:\.MainActivity|ir\.taprasystem\.employee\.MainActivity)"
                   r"\s+t[0-9]+(?:\s+[^{}]*)?\}\s*")
        for record in records:
            match = re.fullmatch(pattern, record)
            if not match or match.group(1) != "0":
                raise ValueError("Foreground TAPRA activity must belong to Android user 0")
        return
    raise ValueError("Foreground TAPRA user evidence is missing")


def extract_identity(package_dump, activity_dump):
    require_foreground_user_zero(activity_dump)
    candidates = [line for line in package_dump.splitlines()
                  if re.match(r"^[ \t]*(?:userId|appId)\s*=", line)]
    if len(candidates) != 1:
        raise ValueError("Expected exactly one package userId or appId field")
    identity = re.fullmatch(r"[ \t]*(?:userId|appId)=([1-9][0-9]{0,8})[ \t]*", candidates[0])
    if not identity:
        raise ValueError("Package identity field is malformed")
    return identity.group(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package_dump", type=Path)
    parser.add_argument("android_user", type=Path)
    args = parser.parse_args(argv)
    try:
        identity = extract_identity(args.package_dump.read_text(encoding="utf-8"),
                                    args.android_user.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Package identity verification failed: {error}", file=sys.stderr)
        return 1
    print(identity)
    return 0


if __name__ == "__main__":
    sys.exit(main())
