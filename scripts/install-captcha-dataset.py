#!/usr/bin/env python3
"""Download the CC0 Kaggle CAPTCHA dataset and build Duck's bounded runtime manifest."""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

try:
    import kagglehub
except ImportError as error:
    raise SystemExit("kagglehub is required. Run: python3 -m pip install kagglehub") from error

DATASET = "parsasam/captcha-dataset"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
ANSWER = re.compile(r"^[A-Za-z0-9]{3,12}$")
IMAGE_COLUMNS = ("image_path", "path", "filename", "file", "image")
ANSWER_COLUMNS = ("solution", "label", "text", "captcha", "answer")
MAX_MANIFEST_ENTRIES = 250_000


def safe_relative(root: Path, value: str, base: Path | None = None) -> Path | None:
    for parent in (base, root):
        if parent is None:
            continue
        candidate = (parent / value).resolve()
        try:
            relative = candidate.relative_to(root.resolve())
        except ValueError:
            continue
        if candidate.suffix.lower() in IMAGE_EXTENSIONS and candidate.is_file():
            return relative
    return None


def csv_labels(root: Path) -> dict[str, str]:
    labels: dict[str, str] = {}
    for table in root.rglob("*.csv"):
        try:
            with table.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                fields = {str(field).strip().lower(): field for field in (reader.fieldnames or [])}
                image_key = next((fields[key] for key in IMAGE_COLUMNS if key in fields), None)
                answer_key = next((fields[key] for key in ANSWER_COLUMNS if key in fields), None)
                if not image_key or not answer_key:
                    continue
                for row in reader:
                    answer = str(row.get(answer_key, "")).strip()
                    relative = safe_relative(root, str(row.get(image_key, "")).strip(), table.parent)
                    if relative and ANSWER.fullmatch(answer):
                        labels[relative.as_posix()] = answer.lower()
        except (OSError, UnicodeError, csv.Error):
            continue
    return labels


def build_manifest(root: Path) -> list[dict[str, str]]:
    mapped = csv_labels(root)
    entries: dict[str, str] = dict(mapped)
    for image in root.rglob("*"):
        if not image.is_file() or image.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        relative = image.relative_to(root).as_posix()
        if relative in entries:
            continue
        label = image.stem.strip()
        if ANSWER.fullmatch(label):
            entries[relative] = label.lower()
    return [{"path": relative, "answer": entries[relative]} for relative in sorted(entries)[:MAX_MANIFEST_ENTRIES]]


def main() -> None:
    parser = argparse.ArgumentParser(description="Install Duck's local image CAPTCHA dataset.")
    parser.add_argument("--target", default="data/captcha-dataset", help="Persistent destination used by Duck")
    parser.add_argument("--force", action="store_true", help="Replace an existing installation after preserving a timestamped backup")
    args = parser.parse_args()

    target = Path(args.target).resolve()
    if target == Path(target.anchor) or len(target.parts) < 3:
        raise SystemExit("Refusing to use an unsafe dataset target.")

    # Download the complete latest dataset through Kaggle's supported client.
    downloaded = Path(kagglehub.dataset_download(DATASET)).resolve()
    print("Path to dataset files:", downloaded)
    if not downloaded.is_dir():
        raise SystemExit("Kaggle did not return an extracted dataset directory.")

    staging = target.with_name(f"{target.name}.installing")
    if staging.exists():
        shutil.rmtree(staging)
    staging.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(downloaded, staging)
    entries = build_manifest(staging)
    if not entries:
        shutil.rmtree(staging)
        raise SystemExit("No labeled CAPTCHA images were found. Duck accepts CSV labels or alphanumeric filename labels.")

    manifest = {
        "version": 1,
        "source": DATASET,
        "license": "CC0-1.0",
        "installedAt": datetime.now(timezone.utc).isoformat(),
        "entries": entries,
    }
    (staging / "duck-captcha-manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    if target.exists():
        if not args.force:
            shutil.rmtree(staging)
            raise SystemExit(f"{target} already exists. Re-run with --force to replace it safely.")
        backup = target.with_name(f"{target.name}.backup-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}")
        target.rename(backup)
        print("Previous installation moved to:", backup)
    staging.rename(target)
    print(f"Installed {len(entries):,} labeled CAPTCHA images at: {target}")
    print(f"Set DUCK_CAPTCHA_DATASET_PATH={target}")


if __name__ == "__main__":
    main()
