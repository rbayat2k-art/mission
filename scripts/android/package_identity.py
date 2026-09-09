"""Read one package identity across Android dumpsys formats, only for user zero."""
import argparse
from pathlib import Path
import re
import sys


def extract_identity(package_dump, android_user):
    if android_user.strip() != "0":
        raise ValueError("Package identity comparison requires current Android user 0")
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
