"""Strict ArchiveV1 validation shared by the reader and local updater."""

import base64
import binascii
import json
import math
import re
from pathlib import Path
from urllib.parse import urlsplit

MAX_ARCHIVE_BYTES = 32 * 1024 * 1024  # Strictly less than this many UTF-8 bytes.
MAX_METADATA_CHARACTERS = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024
EMPTY_ARCHIVE = b'{"version":1,"entries":[]}\n'


class ArchiveError(ValueError):
    """Messages describe fields, never user content or credentials."""


def _object(value, allowed, required):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise ArchiveError("Object fields do not match ArchiveV1.")
    return value


def _characters(value):
    # Match JavaScript String.length, including two UTF-16 units for emoji.
    try:
        return len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError as exc:
        raise ArchiveError("Text contains an unpaired Unicode surrogate.") from exc


def _string(value, limit, required=False):
    if not isinstance(value, str) or _characters(value) > limit or (required and not value.strip()):
        raise ArchiveError("A text field is missing or exceeds its limit.")
    return value


def _id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise ArchiveError("Invalid QR or image ID.")
    return value


def _keywords(value):
    if not isinstance(value, list) or len(value) > 100:
        raise ArchiveError("Keyword lists are limited to 100 items.")
    for item in value:
        _string(item, 120, True)


def _image(value):
    _object(value, ("id", "name", "dataUrl"), ("id", "name", "dataUrl"))
    _id(value["id"])
    _string(value["name"], 255, True)
    data_url = _string(value["dataUrl"], math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 50, True)
    prefix, separator, payload = data_url.partition(",")
    mime = {
        "data:image/png;base64": "png", "data:image/jpeg;base64": "jpeg",
        "data:image/gif;base64": "gif", "data:image/webp;base64": "webp",
    }.get(prefix)
    if not mime or not separator or not payload:
        raise ArchiveError("Images must contain PNG, JPEG, GIF or WebP Base64 data.")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ArchiveError("Invalid image Base64.") from exc
    if base64.b64encode(raw).decode("ascii") != payload:
        raise ArchiveError("Image Base64 must use canonical padding.")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ArchiveError("An image exceeds 10 MiB.")
    valid = {
        "png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
        "jpeg": raw.startswith(b"\xff\xd8\xff"),
        "gif": raw.startswith((b"GIF87a", b"GIF89a")),
        "webp": raw.startswith(b"RIFF") and raw[8:12] == b"WEBP",
    }[mime]
    if not valid:
        raise ArchiveError("Image signature does not match its MIME type.")
    return len(raw)


def validate_archive(value):
    """Accept the common desktop/web/Android limits without changing content."""
    _object(value, ("version", "entries"), ("version", "entries"))
    if type(value["version"]) is not int or value["version"] != 1:
        raise ArchiveError("Archive version must be 1.")
    entries = value["entries"]
    if not isinstance(entries, list) or len(entries) > 300:
        raise ArchiveError("Archives are limited to 300 QR entries.")
    ids = set()
    total_image_bytes = 0
    metadata = []
    fields = ("id", "title", "keywords", "weakKeywords", "content", "images", "favorite", "sourceUrl", "updatedAt")
    for entry in entries:
        _object(entry, fields, [field for field in fields if field != "sourceUrl"])
        entry_id = _id(entry["id"])
        if entry_id in ids:
            raise ArchiveError("Duplicate QR ID.")
        ids.add(entry_id)
        _string(entry["title"], 120, True)
        _string(entry["content"], 4000)
        _keywords(entry["keywords"])
        _keywords(entry["weakKeywords"])
        if type(entry["favorite"]) is not bool:
            raise ArchiveError("favorite must be a boolean.")
        updated = entry["updatedAt"]
        if type(updated) not in (int, float) or not math.isfinite(updated) or int(updated) != updated or not 0 <= updated <= 9007199254740991:
            raise ArchiveError("updatedAt must be a nonnegative JavaScript safe integer.")
        if "sourceUrl" in entry:
            source = _string(entry["sourceUrl"], 2048, True)
            try:
                url = urlsplit(source)
                if url.scheme not in ("http", "https") or not url.hostname or "@" in url.netloc or re.search(r"[\\\x00-\x20\x7f]", source):
                    raise ValueError()
                _ = url.port  # Validate malformed/out-of-range ports, as desktop URL does.
            except ValueError as exc:
                raise ArchiveError("sourceUrl must be HTTP(S) without credentials.") from exc
        images = entry["images"]
        if not isinstance(images, list) or len(images) > 10:
            raise ArchiveError("Each QR is limited to 10 images.")
        image_ids = set()
        for image in images:
            total_image_bytes += _image(image)
            if image["id"] in image_ids:
                raise ArchiveError("Duplicate image ID within a QR.")
            image_ids.add(image["id"])
        if not entry["content"].strip() and not images:
            raise ArchiveError("Each QR needs reply text or an image.")
        if total_image_bytes > MAX_TOTAL_IMAGE_BYTES:
            raise ArchiveError("Archive images together exceed the Android limit of 16 MiB.")
        metadata.append({**entry, "images": [{**image, "dataUrl": ""} for image in images]})
    compact_metadata = json.dumps({"version": 1, "entries": metadata}, ensure_ascii=False, separators=(",", ":"))
    if _characters(compact_metadata) > MAX_METADATA_CHARACTERS:
        raise ArchiveError("Compact text and metadata exceed 2 Mi UTF-16 code units.")
    return value


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ArchiveError("Duplicate JSON field.")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ArchiveError("Non-finite JSON numbers are not allowed.")


def parse_archive(raw):
    if not isinstance(raw, bytes) or len(raw) >= MAX_ARCHIVE_BYTES:
        raise ArchiveError("Archive must be smaller than 32 MiB.")
    try:
        parsed = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs, parse_constant=_invalid_constant)
        return validate_archive(parsed)
    except ArchiveError:
        raise
    except (ValueError, RecursionError, OverflowError) as exc:
        raise ArchiveError("Archive is not valid UTF-8 ArchiveV1 JSON.") from exc


def read_bounded(path):
    with Path(path).open("rb") as source:
        raw = source.read(MAX_ARCHIVE_BYTES)
    if len(raw) >= MAX_ARCHIVE_BYTES:
        raise ArchiveError("Archive must be smaller than 32 MiB.")
    return raw
