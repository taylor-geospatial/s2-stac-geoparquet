# Moving the published catalog to tge-labs

The catalog was published at `portolan-mirrors/sentinel-2-catalog` on Source
Cooperative. It now publishes to `tge-labs/s2-stac-geoparquet`. The repository
side of that move is merged. This directory documents the steps that move
the bytes, which someone with credentials runs by hand.

These files stay inside the repository and outside `catalog/`, so
`tools/publish.py` never reads them and none of them is published.

| | Retired | Current |
|---|---|---|
| Human page | https://source.coop/portolan-mirrors/sentinel-2-catalog | https://source.coop/tge-labs/s2-stac-geoparquet |
| STAC root | `https://data.source.coop/portolan-mirrors/sentinel-2-catalog/catalog.json` | `https://data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json` |
| Bucket prefix | `s3://us-west-2.opendata.source.coop/portolan-mirrors/sentinel-2-catalog/` | `s3://us-west-2.opendata.source.coop/tge-labs/s2-stac-geoparquet/` |
| STAC catalog id | `sentinel-2-catalog` | `s2-stac-geoparquet` |

The retired prefix keeps its objects. Step 5 adds a notice pointing at the new
location, so an existing URL keeps answering while a reader learns where the
catalog went.

## Before you start

1. **The Source Cooperative product must exist.** On 2026-10-02
   `source.coop/tge-labs/s2-stac-geoparquet` rendered "Product Not Found",
   and the gateway answered `NoSuchBucket` for the prefix. Create the product
   under the `tge-labs` organization first. Every step below depends on it.

2. **Know which identity writes where.** Source Cooperative scopes a role to
   one organization, so the role that writes `portolan-mirrors` cannot write
   `tge-labs`. Step 2 needs one identity that reads the old prefix and writes
   the new one. `sync_data.sh` checks for both before it copies anything.

3. **Refresh the session.** The `portolan-mirrors` profile chains through the
   `radiant-source` SSO session, which expires:

   ```bash
   aws sso login --sso-session radiant-source
   ```

## Steps

### 1. Set the role variable

A workflow that writes to Source Cooperative reads its role ARN from the
repository variable `SOURCE_COOP_ROLE_ARN`. No workflow states an ARN inline,
because the role changes with the organization. Set the variable to the role
Source Cooperative provisions for `tge-labs`:

```bash
gh variable set SOURCE_COOP_ROLE_ARN --body 'arn:aws:iam::...:role/...'
gh workflow run check-access.yml
```

`check-access` round-trips a marker object under the new prefix. It fails with
a named error when the variable is empty.

### 2. Copy the objects

Both prefixes are in one bucket, so the copy is server-side. No object travels
to your machine, and no egress is billed.

```bash
bash migration/sync_data.sh                      # inventory and plan
bash migration/sync_data.sh --confirm            # copy
bash migration/sync_data.sh --verify             # compare the two prefixes
```

The copy leaves behind the scratch prefixes the retired location accumulated:
`_work/`, `_smoke/`, `_experiments/` and `_access-check`. They are build
artifacts rather than catalog content. `_assets/` is copied, because
`catalog.json` links the icon in it.

`--verify` lists both prefixes and compares every key and size. It exits
non-zero on a difference and prints the first 60 differing lines.

### 3. Check the data answers

```bash
curl -fsI https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=2021/items.parquet
```

A `200` with an accurate `Content-Length` means the gateway serves the new
prefix. Portolan requires range requests and CORS headers on every file, which
step 6 verifies across the catalog.

### 4. Publish the metadata

The copy in step 2 brought the old metadata across. Replace it with metadata
generated against the new location, so the measured fields are restamped from
the new bucket:

```bash
gh workflow run publish-catalog.yml
```

`publish-catalog` restamps the row counts, extents, part sizes and `updated`
of both item indexes and both stats collections from the bucket, then uploads
`catalog/`. Run it rather than `tools/publish.py`, because the committed
metadata lags the published numbers. The committed `stats-c1` collection reads
0 rows, where the published one read 2,528,396 on 2026-10-03.

Asset hrefs in the catalog are relative, so they need no rewrite. The one
absolute data URL per collection is `partition:glob`, already repointed in the
repository.

### 5. Mark the retired prefix

```bash
python3 migration/deprecate_old_prefix.py                    # print the plan
python3 migration/deprecate_old_prefix.py --confirm          # upload
```

This reads the published `catalog.json` and `README.md` at the retired prefix,
adds a notice giving the new location, and adds `successor-version` and
`canonical` links to the new root. Everything else in those two objects is
carried over unchanged, so the child links keep resolving.

It writes the retired prefix, so it needs the `portolan-mirrors` profile
rather than the identity from step 2.

### 6. Confirm conformance against the live host

```bash
rashid check --live \
  --live-base-url https://data.source.coop/tge-labs/s2-stac-geoparquet/ catalog
```

Then open the catalog in the browser and confirm the collections and the
default styles render:

https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json

### 7. Point the explorer at the new prefix

`apps/explorer/app.js` reads the new base already. Deploy it:

```bash
gh workflow run pages.yml
```

Then load https://research.taylorgeospatial.org/s2-stac-geoparquet/ and run one
search, so a real query confirms the parts and the sidecar resolve.

### 8. Re-register the catalog

The catalog is listed in the Portolan registry under its old URL. Open a pull
request against the registry that points the entry at the new root. The
`portolan:register-catalog` skill covers the file format.

## The gate that keeps this from drifting

`tests/test_location.py` fails when any file still carries a retired location, when
`write_prefix` and `public_base` disagree, or when a workflow inlines a role
ARN. It derives the expected location from `catalog.publish.yaml`, so the next
move needs one edit there plus one entry in that gate's `RETIRED` tuple.

The dated design records under `docs/superpowers/` keep the old URLs on
purpose. A spec written on 2026-09-15 describes where the catalog published
that day, and rewriting it would falsify the record.
