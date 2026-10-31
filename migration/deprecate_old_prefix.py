#!/usr/bin/env python3
"""Mark the retired location as moved, without breaking it.

The catalog moved from portolan-mirrors/sentinel-2-catalog to
tge-labs/s2-stac-geoparquet. The old objects stay in place, so a URL in
someone's script keeps working. This script adds the pointer that tells a
reader, and a crawler, where the catalog lives now.

It edits the published root catalog.json and README.md of the old prefix:

  * the description gains a leading notice naming the new location,
  * the links gain `successor-version` and `canonical` to the new root,
  * the README gains the same notice above its first line.

Everything else in those two objects is carried over byte for byte, so the
child links keep resolving and a client that ignores the notice sees the
catalog it saw before.

Nothing else at the old prefix is touched. The collections, the items and the
data files are left exactly as they are.

It writes through the Source Cooperative gateway with the credentials the
`source-coop` CLI issues. Run `source-coop login` first.

Usage:
    python3 migration/deprecate_old_prefix.py                  # print the plan
    python3 migration/deprecate_old_prefix.py --confirm        # upload
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

# At the gateway the organization is the bucket and the product is the first
# key segment. This is not the raw AWS bucket in catalog.publish.yaml.
ENDPOINT = "https://data.source.coop"
BUCKET = "portolan-mirrors"
OLD_KEY = "sentinel-2-catalog"
OLD_HTTPS = f"https://data.source.coop/{BUCKET}/{OLD_KEY}"
NEW_HTTPS = "https://data.source.coop/tge-labs/s2-stac-geoparquet"
NEW_PAGE = "https://source.coop/tge-labs/s2-stac-geoparquet"

NOTICE_MD = (
    f"> **This catalog has moved.** It is published at\n"
    f"> [{NEW_PAGE}]({NEW_PAGE}), with its STAC root at\n"
    f"> `{NEW_HTTPS}/catalog.json`. The objects under this prefix stay in\n"
    f"> place and keep answering, and they stop being updated. Point new work\n"
    f"> at the new location.\n"
)

NOTICE_STAC = (
    f"**This catalog has moved to {NEW_PAGE}.** Its STAC root is now "
    f"{NEW_HTTPS}/catalog.json. The objects under this prefix stay in place "
    f"and keep answering, and they stop being updated.\n\n"
)

NEW_LINKS = [
    {"rel": "successor-version", "href": f"{NEW_HTTPS}/catalog.json",
     "type": "application/json",
     "title": "The current location of this catalog"},
    {"rel": "canonical", "href": f"{NEW_HTTPS}/catalog.json",
     "type": "application/json",
     "title": "The current location of this catalog"},
]


def fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url, headers={"User-Agent": "s2-stac-geoparquet-tools/1.0 "
                                    "(+https://github.com/taylor-geospatial/"
                                    "s2-stac-geoparquet)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def patch_catalog(raw: bytes) -> str:
    doc = json.loads(raw)

    desc = doc.get("description", "")
    if NOTICE_STAC.strip() in desc:
        print("  catalog.json: notice already present")
    else:
        doc["description"] = NOTICE_STAC + desc

    have = {(l.get("rel"), l.get("href")) for l in doc.get("links", [])}
    added = [l for l in NEW_LINKS if (l["rel"], l["href"]) not in have]
    doc.setdefault("links", []).extend(added)
    print(f"  catalog.json: +{len(added)} link(s), "
          f"description +{len(NOTICE_STAC)} chars")

    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def patch_readme(raw: bytes) -> str:
    text = raw.decode("utf-8")
    if NOTICE_MD.strip().splitlines()[0] in text:
        print("  README.md: notice already present")
        return text

    lines = text.splitlines(keepends=True)
    # Keep the title first, so the rendered page still opens with a heading.
    if lines and lines[0].startswith("#"):
        head, rest = lines[0], "".join(lines[1:])
        out = f"{head}\n{NOTICE_MD}\n{rest.lstrip(chr(10))}"
    else:
        out = f"{NOTICE_MD}\n{text}"
    print(f"  README.md: notice added above the body")
    return out


AWS_CONFIG = """[profile s2mig_dep]
region = us-west-2
credential_process = source-coop creds --format credential-process
"""


def upload(body: str, key: str, content_type: str) -> None:
    cfg = pathlib.Path(tempfile.gettempdir()) / "s2-migration" / "awsconfig-dep"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(AWS_CONFIG)
    env = dict(os.environ, AWS_CONFIG_FILE=str(cfg))
    subprocess.run(
        ["aws", "--profile", "s2mig_dep", "--region", "us-west-2",
         "--endpoint-url", ENDPOINT,
         "s3", "cp", "-", f"s3://{BUCKET}/{key}",
         "--content-type", content_type],
        input=body.encode("utf-8"), check=True, env=env)
    print(f"  uploaded s3://{BUCKET}/{key}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--confirm", action="store_true",
                    help="upload the patched objects")
    args = ap.parse_args()

    print(f"reading the published objects at {OLD_HTTPS}/")
    try:
        cat_raw = fetch(f"{OLD_HTTPS}/catalog.json")
        rd_raw = fetch(f"{OLD_HTTPS}/README.md")
    except Exception as exc:  # noqa: BLE001 - report and stop
        print(f"FAIL: could not read the retired prefix ({exc})",
              file=sys.stderr)
        return 1

    print("patching:")
    cat_out = patch_catalog(cat_raw)
    rd_out = patch_readme(rd_raw)

    if not args.confirm:
        print("\n--- catalog.json description (first 400 chars) ---")
        print(json.loads(cat_out)["description"][:400])
        print("\n--- README.md (first 12 lines) ---")
        print("\n".join(rd_out.splitlines()[:12]))
        print("\nDry run. Re-run with --confirm to upload.")
        return 0

    print("\nuploading through the gateway")
    upload(cat_out, f"{OLD_KEY}/catalog.json", "application/json")
    upload(rd_out, f"{OLD_KEY}/README.md", "text/markdown")
    print("\ndone. The retired prefix now points at the new location.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
