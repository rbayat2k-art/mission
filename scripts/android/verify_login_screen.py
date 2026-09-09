"""Verify public emulator screenshots without mistaking empty WebView XML for login."""

import argparse
from pathlib import Path
import re
import struct
import subprocess
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zlib


PACKAGE = "ir.taprasystem.employee"
LOGIN_LABELS = ("ورود به پنل کارمند", "نام کاربری", "رمز عبور", "ورود به پنل")
OBSOLETE_HEADING = "نمایشگر وب گوشی نیاز به به‌روزرسانی دارد"
REJECTED_PHRASES = (
    "صفحه سامانه بارگذاری نشد", "در حال بازکردن راهکار",
    "در حال بازگردانی صفحه شما", "ارتباط با سامانه برقرار نشد",
    "سرور پاسخ مناسبی نداد", "اتصال امن سایت تأیید نشد",
    "تنظیم باتری برای ورود الزامی است",
)
TIMEOUT_SECONDS = 30
MAX_PNG_BYTES = 20 * 1024 * 1024


class VerificationError(RuntimeError):
    """Positive evidence is missing; never infer success from an empty hierarchy."""


def normalize(text):
    # No fuzzy matching, punctuation stripping, OCR substitution, or token reversal.
    text = unicodedata.normalize("NFC", text).translate(str.maketrans({"ي": "ی", "ك": "ک"}))
    text = re.sub("[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]", "", text)
    return " ".join(text.split())


def run_command(arguments):
    try:
        result = subprocess.run(arguments, capture_output=True, timeout=TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VerificationError("Screenshot verification command unavailable or timed out") from error
    if result.returncode != 0:
        raise VerificationError(f"Screenshot verification command failed with status {result.returncode}")
    return result.stdout


def require_foreground():
    activities = run_command(["adb", "shell", "dumpsys", "activity", "activities"]).decode("utf-8", "replace")
    resumed = re.findall(r"^\s*(?:mResumedActivity|topResumedActivity|mFocusedActivity)\s*[:=].*$", activities, re.M)
    component = r"\bir\.taprasystem\.employee/(?:\.MainActivity|ir\.taprasystem\.employee\.MainActivity)\b"
    if not any(re.search(component, line) for line in resumed):
        raise VerificationError("TAPRA MainActivity is not the foreground activity")


def validate_png(data):
    """Validate complete non-interlaced 8-bit RGB/RGBA output from adb screencap."""
    if not isinstance(data, bytes) or len(data) > MAX_PNG_BYTES or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise VerificationError("Fresh screenshot is not a valid PNG")
    offset, chunks, compressed = 8, [], bytearray()
    width = height = channels = 0
    while offset < len(data):
        if offset + 12 > len(data):
            raise VerificationError("Truncated PNG chunk")
        size = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if end > len(data):
            raise VerificationError("Truncated PNG payload")
        payload = data[offset + 8:offset + 8 + size]
        crc = struct.unpack(">I", data[end - 4:end])[0]
        if zlib.crc32(kind + payload) & 0xffffffff != crc:
            raise VerificationError("PNG checksum mismatch")
        if not chunks and kind != b"IHDR":
            raise VerificationError("Missing PNG image header")
        if kind == b"IHDR":
            if chunks or size != 13:
                raise VerificationError("Invalid PNG image header")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if not (0 < width <= 4096 and 0 < height <= 8192) or depth != 8 or color not in (2, 6) or (compression, filtering, interlace) != (0, 0, 0):
                raise VerificationError("Unsupported screenshot PNG layout")
            channels = 3 if color == 2 else 4
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            if size or end != len(data) or not compressed:
                raise VerificationError("Invalid PNG end marker")
        elif kind[0] & 32 == 0:
            raise VerificationError("Unexpected critical PNG chunk")
        chunks.append(kind)
        offset = end
    if not chunks or chunks[-1] != b"IEND":
        raise VerificationError("Incomplete PNG")
    expected = height * (1 + width * channels)
    if expected > 64 * 1024 * 1024:
        raise VerificationError("Screenshot dimensions are too large")
    try:
        decoder = zlib.decompressobj()
        pixels = decoder.decompress(compressed, expected + 1)
    except zlib.error as error:
        raise VerificationError("PNG image data is corrupt") from error
    if len(pixels) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise VerificationError("PNG image data is incomplete or oversized")
    if any(pixels[row * (1 + width * channels)] > 4 for row in range(height)):
        raise VerificationError("Invalid PNG row filter")


def hierarchy_text(path):
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as error:
        raise VerificationError("TAPRA hierarchy evidence is missing or malformed") from error
    nodes = list(root.iter("node"))
    if root.tag != "hierarchy" or not any(node.get("package") == PACKAGE for node in nodes):
        raise VerificationError("Hierarchy is not owned by TAPRA")
    return "\n".join(node.get(attribute, "") for node in nodes for attribute in ("text", "content-desc"))


def reject_error_text(text):
    normalized = normalize(text)
    if any(normalize(phrase) in normalized for phrase in REJECTED_PHRASES):
        raise VerificationError("Loading, battery, or failure screen is still visible")


def require_login_text(text):
    reject_error_text(text)
    if normalize(OBSOLETE_HEADING) in normalize(text):
        raise VerificationError("Obsolete WebView rejection is not a login success")
    # Separate exact lines ensure the submit label is not satisfied by its heading prefix.
    lines = {normalize(line) for line in text.splitlines()}
    if not all(normalize(label) in lines for label in LOGIN_LABELS):
        raise VerificationError("Fresh OCR does not contain every exact employee login label")


def verify_screen(xml_path, png_path, expected):
    if expected not in ("login", "obsolete-webview"):
        raise VerificationError("Unknown screen expectation")
    png_path = Path(png_path)
    ocr_path = png_path.with_suffix(".ocr.txt")
    if png_path.exists() or png_path.is_symlink() or ocr_path.exists() or ocr_path.is_symlink():
        raise VerificationError("Existing screenshot or OCR evidence cannot be reused")
    text = hierarchy_text(xml_path)
    require_foreground()
    screenshot = run_command(["adb", "exec-out", "screencap", "-p"])
    validate_png(screenshot)
    try:
        with png_path.open("xb") as image:
            image.write(screenshot)
        # Preserve a fresh public failure screenshot before rejecting a loading/error UI.
        reject_error_text(text)
        if expected == "login":
            recognized = run_command(["tesseract", str(png_path), "stdout", "-l", "fas+eng", "--psm", "11"])
            try:
                recognized = recognized.decode("utf-8")
            except UnicodeDecodeError as error:
                raise VerificationError("OCR output is not valid UTF-8") from error
            with ocr_path.open("x", encoding="utf-8") as evidence:
                evidence.write(recognized)
            require_login_text(recognized)
        elif normalize(OBSOLETE_HEADING) not in {normalize(line) for line in text.splitlines()}:
            raise VerificationError("Exact native obsolete-WebView rejection heading is missing")
    except OSError as error:
        raise VerificationError("Fresh screenshot evidence could not be saved") from error
    require_foreground()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xml", required=True, type=Path)
    parser.add_argument("--png", required=True, type=Path)
    parser.add_argument("--expect", required=True, choices=("login", "obsolete-webview"))
    arguments = parser.parse_args(argv)
    try:
        verify_screen(arguments.xml, arguments.png, arguments.expect)
    except VerificationError as error:
        print(f"Public screen verification failed: {error}", file=sys.stderr)
        return 1
    if arguments.expect == "login":
        print("Fresh screenshot OCR verified the exact employee login heading, input labels and submit label.")
    else:
        print("Verified stock obsolete-WebView rejection only; successful login compatibility is NOT established.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
