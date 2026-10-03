#!/usr/bin/env python3
"""Every file names one published location, and it is the configured one.

The catalog moved published location once, from
portolan-mirrors/sentinel-2-catalog to tge-labs/s2-stac-geoparquet. That move
touched 36 files: the publish config, the STAC JSON, seven workflows, the
explorer, the tools, the tests and the docs. A URL that keeps the old prefix
still resolves while the old objects stay in place, so nothing fails loudly
and the stale copy reads as current. This gate is what makes the next move,
or a half-finished edit of this one, fail in CI instead.

The expected location comes from catalog.publish.yaml, so this file holds no
second copy of it. Add the location in one place and every check here follows.

Three kinds of path are exempt, and each is recorded rather than inferred:

  * docs/superpowers/ holds the dated design records. A spec written on
    2026-09-15 describes where the catalog was published that day. Rewriting
    it would falsify the record.
  * migration/ documents the move itself. Its runbook and its two scripts
    name the source and the destination, so a gate that forbids the retired
    name would forbid the file that retires it.
  * A local scratchpad path or an .superpowers/sdd/ note quotes a directory
    name from a past working tree. Neither is a published URL.

Run: python3 tests/test_location.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from publish import load_config  # noqa: E402

config = load_config()
PUBLIC_BASE = config["public_base"].rstrip("/")
WRITE_PREFIX = config["write_prefix"].rstrip("/")

# The org/product pair, read off the configured public base. One string
# identifies the location in an https URL, an s3 URI and a bare key prefix.
LOCATION = "/".join(PUBLIC_BASE.split("/")[-2:])

# Every published location this catalog has used. The current one must be
# the last entry, and every earlier one must be absent from the tree.
RETIRED = ("portolan-mirrors/sentinel-2-catalog",)

SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", "node_modules"}
# The dated design records, and the runbook for the move. See the docstring.
SKIP_PREFIXES = ("docs/superpowers/", "migration/")
# This gate holds the retired locations it searches for, so it cannot
# search itself.
SKIP_FILES = {Path(__file__).resolve().relative_to(ROOT).as_posix()}
TEXT_SUFFIXES = {".md", ".json", ".yaml", ".yml", ".py", ".js", ".mjs",
                 ".html", ".css", ".sh", ".sbatch", ".txt", ".ini"}

errors: list[str] = []


def tracked_text_files():
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in TEXT_SUFFIXES:
            continue
        rel = path.relative_to(ROOT).as_posix()
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if rel.startswith(SKIP_PREFIXES) or rel in SKIP_FILES:
            continue
        yield rel, path


# --- 1. the config names one location through both doors --------------------

if not WRITE_PREFIX.endswith(LOCATION):
    errors.append(
        f"catalog.publish.yaml: write_prefix {WRITE_PREFIX!r} and public_base "
        f"{PUBLIC_BASE!r} name different locations")

if not WRITE_PREFIX.startswith("s3://us-west-2.opendata.source.coop/"):
    errors.append(
        f"catalog.publish.yaml: write_prefix {WRITE_PREFIX!r} does not name "
        "the Source Cooperative bucket")

if not PUBLIC_BASE.startswith("https://data.source.coop/"):
    errors.append(
        f"catalog.publish.yaml: public_base {PUBLIC_BASE!r} does not name the "
        "data.source.coop gateway")


# --- 2. no file carries a retired location ----------------------------------

for rel, path in tracked_text_files():
    body = path.read_text(encoding="utf-8", errors="replace")
    for retired in RETIRED:
        if retired in body:
            for n, line in enumerate(body.splitlines(), 1):
                if retired in line:
                    errors.append(
                        f"{rel}:{n}: names the retired location {retired!r}; "
                        f"the published location is {LOCATION!r}")


# --- 3. every source.coop URL in the tree names the configured location -----

# Any https gateway URL or s3 bucket URI, with whatever follows the host.
URL_RE = re.compile(
    r"(?:https://data\.source\.coop|s3://us-west-2\.opendata\.source\.coop)"
    r"/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)")

for rel, path in tracked_text_files():
    body = path.read_text(encoding="utf-8", errors="replace")
    for n, line in enumerate(body.splitlines(), 1):
        for found in URL_RE.findall(line):
            if found != LOCATION:
                errors.append(
                    f"{rel}:{n}: URL names {found!r}, not the published "
                    f"location {LOCATION!r}")


# --- 4. no workflow carries a hardcoded Source Cooperative role ARN ---------

# Source Cooperative provisions the write role per organization, so the ARN
# changes with the location while nothing in the catalog reveals its name.
# One repository variable holds it. A workflow that inlines an ARN instead
# goes stale silently the next time the location moves.
WORKFLOWS = ROOT / ".github" / "workflows"
ROLE_RE = re.compile(r"arn:aws:iam::\d+:role/[A-Za-z0-9+=,.@_-]+")

for path in sorted(WORKFLOWS.glob("*.yml")):
    body = path.read_text()
    for n, line in enumerate(body.splitlines(), 1):
        for arn in ROLE_RE.findall(line):
            errors.append(
                f".github/workflows/{path.name}:{n}: inlines the role ARN "
                f"{arn!r}; read vars.SOURCE_COOP_ROLE_ARN instead")

if "SOURCE_COOP_ROLE_ARN" not in (WORKFLOWS / "check-access.yml").read_text():
    errors.append(
        ".github/workflows/check-access.yml: does not read "
        "vars.SOURCE_COOP_ROLE_ARN; it is the smoke test for the credentials")


# --- report -----------------------------------------------------------------

if errors:
    for e in errors:
        print(f"FAIL {e}")
    print(f"\n{len(errors)} problem(s)")
    raise SystemExit(1)

print(f"published location: {LOCATION}")
print(f"  gateway: {PUBLIC_BASE}")
print(f"  bucket:  {WRITE_PREFIX}")
print("every URL in the tree names it; no workflow inlines a role ARN")
