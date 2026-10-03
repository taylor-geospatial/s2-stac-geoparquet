# Sentinel-2 L2A STAC-GeoParquet mirror

Every Sentinel-2 L2A scene that AWS Earth Search indexes, republished as a
[Portolan](https://www.portolan-sdi.org/) catalog of partitioned
STAC-GeoParquet you query in place. The collection `sentinel-2-c1-l2a` indexes
**30,396,466 scenes from October 2015 onward**, and `sentinel-2-l2a` indexes
**51,279,608 from November 2016**. Both refresh daily.

A row is one scene. It states the footprint, the acquisition time, the MGRS
tile, the cloud cover, the scene-classification percentages and the complete
upstream `assets` object, so a scene's Cloud-Optimized GeoTIFF URLs sit in the
row that describes it.

The imagery stays on AWS in public buckets. This catalog publishes the item
index and a small set of MGRS-tile aggregates, with **no API in front of it**.
A client filters the whole archive with HTTP range reads against a public
bucket, without a key and without a server.

- **Explore it**: https://research.taylorgeospatial.org/s2-stac-geoparquet/, a
  static page that behaves as though an API sat behind it. Each query runs on
  [hyparquet](https://github.com/hyparam/hyparquet) range reads plus PMTiles,
  because a small pure-JS parquet reader replaces a 36 MB WASM query engine.
  The page draws any band, composite, NDVI/NDWI or SCL class of a scene
  straight from its COGs in the browser, with histogram-and-handles stretch
  controls. It opens on Collection 1, the uniform reprocessed record. A switch
  in the sidebar, or `?collection=sentinel-2-l2a`, points the same page at the
  original index.
- **Published catalog**: https://source.coop/tge-labs/s2-stac-geoparquet
- **STAC root**: `https://data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json`
- **Browse it**: [the Portolan browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json)
- **Upstream**: [Earth Search](https://earth-search.aws.element84.com/v1) by
  [Element 84](https://element84.com/), over the
  [Sentinel-2 L2A COGs](https://registry.opendata.aws/sentinel-2-l2a-cogs/) on
  the AWS Registry of Open Data
- **Issues and contributions**: https://github.com/taylor-geospatial/s2-stac-geoparquet/issues

Agents should read [`catalog/AGENTS.md`](catalog/AGENTS.md) and the agent guide
of the collection they query.

## Query it

The driving use case is a field and a planting or harvest window, from a
script, with no API in the way. Find the cloud-free scenes over one MGRS tile.
Because a tile and a year identify the file, this reads one object and only the
row groups that store the tile:

```sql
INSTALL httpfs; LOAD httpfs;
SET TimeZone = 'UTC';

SELECT id, datetime, "eo:cloud_cover" AS cloud, thumbnail_url
FROM read_parquet('https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=2021/items.parquet')
WHERE _tile = '31UFU'
  AND datetime BETWEEN '2021-08-01' AND '2021-10-15 23:59:59'
  AND "eo:cloud_cover" <= 10
ORDER BY "eo:cloud_cover", id
LIMIT 30;
```

Collection 1 joins on `_tile`, a column this mirror derives from `grid:code`,
because Collection 1 items omit `s2:mgrs_tile`. The original index does include
`s2:mgrs_tile`, and queries it instead. Column names containing a colon need
double quotes.

The `assets` column stores the COG URLs as a JSON string of the upstream STAC
assets object. It is the widest column in the table, so read it for the scenes
you chose rather than for each candidate:

```sql
INSTALL httpfs; LOAD httpfs;

SELECT json_extract_string(assets, '$.visual.href') AS visual,
       json_extract_string(assets, '$.red.href')    AS red,
       json_extract_string(assets, '$.scl.href')    AS scl
FROM read_parquet('https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=2021/items.parquet')
WHERE _tile = '31UFU'
  AND datetime BETWEEN '2021-10-04' AND '2021-10-04 23:59:59'
LIMIT 1;
```

Swap `$.visual.href` for any key on the scene, such as `red`, `nir`, `scl` or
`thumbnail`. The
[collection agent guide](catalog/sentinel-2-c1-l2a/AGENTS.md) lists each key. A
Collection 1 id reads `S2B_T31UET_20260921T105030_L2A`, where the tile takes a
`T` prefix that the `_tile` column drops.

**The whole archive.** Each collection sets `partition:glob` to
`year=*/*.parquet`. DuckDB expands a glob when it can list the store, which it
can do over `s3://` anonymously:

```sql
INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-west-2';
SET s3_url_style = 'path';
SET TimeZone = 'UTC';

SELECT year, count(*) AS scenes, min(datetime) AS first, max(datetime) AS last
FROM read_parquet('s3://us-west-2.opendata.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=*/*.parquet',
                  hive_partitioning = true)
WHERE year IN (2016, 2017)
GROUP BY year ORDER BY year;
```

`hive_partitioning` exposes `year` as a column the files omit, and a filter on
it skips whole files, so that query opens two years out of twelve.

Over plain `https://` DuckDB does not expand a glob. It reports "Globs (`*`)
for generic HTTP file are not supported", and the fix is to list the parts by
name.

The parts run 0.1 GB to 2.8 GB each, and in either form a full scan over HTTP
can fail partway on some networks. Even a `count(*)` over
each part, which reads only footers and row-group statistics, took four minutes
on one run here and hit DuckDB's HTTP timeout on another. Each snippet on this
page is a range-pruned read by design, so raise `http_timeout` and
`http_retries` before you scan wider.

The live tail and the archive parts are disjoint. The daily rebuild re-reads a
lookback window from Earth Search and drops each id the archive parts already
store. An overlap is possible only during a consolidation, in the minutes
between the upload of the merged archive parts and the upload of the emptied
tail. Deduping on `id` is always safe, and it removes nothing when nothing
overlaps.

## Four collections, two pairs

Each item index has a stats collection beside it. Start with Collection 1,
which is ESA's uniform reprocessing of the archive and the pair the explorer
opens on.

| Collection | Contents | Read it |
|---|---|---|
| [`sentinel-2-c1-l2a`](catalog/sentinel-2-c1-l2a/README.md) | The Collection 1 item index: 30,396,466 scenes, 2015-10-22 to 2026-09-21 at the last restamp, one `items.parquet` per year plus a `live-MM.parquet` tail per month. | [README](catalog/sentinel-2-c1-l2a/README.md), [agent guide](catalog/sentinel-2-c1-l2a/AGENTS.md) |
| [`stats-c1`](catalog/stats-c1/README.md) | MGRS tile by month aggregates over Collection 1, and a tile-footprint tileset. | [README](catalog/stats-c1/README.md), [agent guide](catalog/stats-c1/AGENTS.md) |
| [`sentinel-2-l2a`](catalog/sentinel-2-l2a/README.md) | The original Earth Search item index: 51,279,608 scenes, 2016-11-01 to 2026-09-17 at the last restamp, in zone-partitioned year parts plus a `live.parquet` tail. Complete from December 2018, and before that what Earth Search serves. | [README](catalog/sentinel-2-l2a/README.md), [agent guide](catalog/sentinel-2-l2a/AGENTS.md) |
| [`stats`](catalog/stats/README.md) | The same aggregates over the original index. | [README](catalog/stats/README.md), [agent guide](catalog/stats/AGENTS.md) |

A stats collection is four small products, all keyed by `mgrs_tile`:

- `mgrs-monthly.parquet`: one row per tile per month, storing the whole record
  in 17 MB for `stats-c1` and 21 MB for `stats`. Its columns are
  `scene_count`, `min_cloud_cover`, `median_cloud_cover`, `mean_cover` and
  `max_cover`, which give the share of the tile its scenes fill, with
  `best_item_id` and `best_item_date` identifying the least-cloudy scene of the
  month. Each share is an integer 0-100%. Sorting by
  `(mgrs_tile, year, month)` in 50k-row groups turns one tile's history into a
  range read of one row group.
- `months/YYYY-MM.parquet`: that table cut to one month, paint columns only, at
  about 126 KB for a recent month. The slices appear as no asset, because the
  name pattern is the contract, and a 404 means the month has no tile-months.
- `timeline.parquet`: one row per month over all tiles, a few KB.
- `mgrs.pmtiles`: one polygon per MGRS tile on the vector layer `mgrs`. The
  polygon is the envelope of the tile's scene footprints rather than the true
  grid cell.

Answer "which month has a cloud-free scene here" from the stats rather than
from an archive scan:

```sql
INSTALL httpfs; LOAD httpfs;

SELECT year, month, scene_count, min_cloud_cover, best_item_id, best_item_date
FROM read_parquet('https://data.source.coop/tge-labs/s2-stac-geoparquet/stats-c1/mgrs-monthly.parquet')
WHERE mgrs_tile = '31UFU' AND year = 2021
ORDER BY year, month;
```

And the newest month in a stats table:

```sql
INSTALL httpfs; LOAD httpfs;

SELECT year, month, tile_count, scene_count
FROM read_parquet('https://data.source.coop/tge-labs/s2-stac-geoparquet/stats-c1/timeline.parquet')
ORDER BY year DESC, month DESC
LIMIT 1;
```

## Layout

Both collections place every part directly under `year=YYYY/`, matching the
glob `year=*/*.parquet`, with no `zone=` directory at any level.

`sentinel-2-c1-l2a` is one `items.parquet` per year, in uniform row groups of
about 6,000 rows, sorted by `(_tile, datetime)`. One tile's year is a
contiguous run, so a tile-and-window query reads one or two groups. A year may
also include `live-MM.parquet` files, one per month fetched since the last
fold, because ESA's reprocessing still adds scenes to old years.

`sentinel-2-l2a` grew in vintages, and its shape changed as it grew. Each
vintage reads with the same query, at a different cost in bytes per hit.

| Years | Parts per year | Row groups | Sort order |
|---|---|---|---|
| 2016-2018 | one `items.parquet` | ~100k rows | `(_month, _hilbert)` |
| 2019-2020 | four, by UTM zone: `z01-20`, `z21-35`, `z36-46`, `z47-60.parquet` | ~100k rows | `(_month, _hilbert)` |
| 2021-2023 | eight, by UTM zone: `z01-15`, `z16-20`, `z21-31`, `z32-35`, `z36-40`, `z41-46`, `z47-52`, `z53-60.parquet` | ~100k rows | `(_month, _hilbert)` |
| 2024-2025 | the same eight | ~6k rows | `(_month, _hilbert)` |
| 2026- | the same eight, plus `live.parquet` for the current year | ~6k rows | `(_month, s2:mgrs_tile, _hilbert)` |

The UTM zone is the leading digits of the tile id, so `31UFU` is zone 31. The
eight ranges nest inside the four, and both are fixed for the life of the
catalog, so a tile id and a year together identify one file. Zone 31 in 2021 is
`year=2021/z21-31.parquet`, and in 2019 it is `year=2019/z21-35.parquet`. Each
`year=YYYY/YYYY.json` item lists that year's parts with their row counts and
time ranges, for a reader who would rather discover than assume.

Because the 2026 sort puts one tile's month in one small row group, a tile
lookup there is one range request. Older parts read the same way at more bytes
per hit. Rows sort by `_month` first in each vintage, so a month filter prunes
row groups at every layout. The two `_`-prefixed columns are sort helpers this
mirror adds rather than STAC properties. Measured costs per vintage are in
[`docs/query-performance.md`](docs/query-performance.md).

**Reader floors.** The parts are GeoParquet 2.0 with native geometry. DuckDB
must be 1.4 or newer, and duckdb-wasm 1.32 or newer, because older versions
reject them with "Geoparquet version 2.0.0 is not supported". The explorer
reads them with hyparquet, which sets no such floor.

## Counts and coverage

Earth Search's item counts in the original index roughly halve from 2022, with
8.6 million scenes in 2021 against 4.2 million in 2022, although the satellites
did not acquire less. Earlier years mostly include two items per scene for the
same tile and acquisition, with ids ending `_0_L2A` and `_1_L2A`, and from 2022
the `_1_` twins largely stop. Over tile `31UFU`, 2021 has 454 items for 217
distinct acquisitions, where 2022 has 226 for 217. This mirror is faithful to
its source, adding no rows and dropping none, so the halving reflects Earth
Search's record rather than a gap here.

Coverage in the original index is partial before December 2018 for the same
reason. Its record starts in November 2016 with Earth Search's first L2A COGs,
because 2015 and most of 2016 produced no COG products, and 2017 and 2018 are
partial. Two properties, `sat:orbit_state` and `s2:granule_id`, are NULL on
newer items because Earth Search stopped publishing them.

Collection 1 reaches back to October 2015 instead, since ESA reprocessed the
archive to one baseline. That reprocessing is still running, so an old year
keeps gaining scenes with recent `created` timestamps. The daily refresh for
Collection 1 looks back on `created` rather than `datetime` for that reason.
Each collection's [agent guide](catalog/sentinel-2-c1-l2a/AGENTS.md) records
the NULLs and the quirks to expect from it.

## Update cadence

| Workflow | When | Does |
|---|---|---|
| `refresh-daily` | daily, 03:42 UTC | Fetches the last five days from Earth Search into `live.parquet`, one per year the window touches and two around New Year. It then splices those years into the stats table and restamps counts and extents before uploading, and it commits nothing. A second job does the same for `sentinel-2-c1-l2a` on a `created` lookback of any year, into `stats-c1`, while the repository variable `C1_LIVE_ENABLED` is `true`. Its tail is one file per month, `year=YYYY/live-MM.parquet`, so a day rewrites only the months it fetched. |
| `consolidate-month` | the third of each month, 05:17 UTC | Folds `live.parquet` into the year's archive parts for the current year, and for the previous one while it still has a tail, with one job per part, deduped by `id`. It then empties each folded `live`. |
| `publish-stats` | manual | Rebuilds `mgrs-monthly.parquet`, the month slices, `timeline.parquet` and `mgrs.pmtiles` in full from the published parts, with one matrix entry per collection. |
| `backfill` and `publish-backfill` | manual | Fetch the whole record one month-slice at a time, then run the credentialed year-by-year build and upload. This seeded the archive, and it is also the repair path. |
| `repair-slices` | manual | Re-fetches months from the static item JSON in the `sentinel-cogs` bucket instead of the API, as `slice-YYYY-MM` artifacts that `publish-backfill` consumes unchanged. |
| `upload-file-data` | manual | Publishes one locally built data file, such as `mgrs.pmtiles`, from an https URL into a catalog directory. |
| `check-access` | manual | Writes and deletes a marker object with the Source Cooperative role, as a smoke test of the credentials. |
| `publish-catalog` | manual | Publishes the committed `catalog/` metadata, after restamping the measured fields of both item indexes and both stats collections from the bucket, which keeps the daily restamp. |
| `pages` | on push to `apps/explorer/` | Deploys the explorer to GitHub Pages. |

`tools/make_collection.py` regenerates each item index's `updated` stamp, row
count and temporal extent from the published parts on every refresh, and
`tools/make_stats_collection.py` does the same for a stats collection from its
`timeline.parquet`. The published `collection.json` is the authority on what is
here now, and a committed one can lag it.

## The repository

Catalog metadata is versioned alongside the code, where CI validates each
change. The data is stored in object storage next to it, referenced by URL and
never committed.

| Kind | Where | Example |
|---|---|---|
| Tracked and published | inside `catalog/` | STAC JSON, `README.md`, `AGENTS.md` |
| Tracked, never published | outside `catalog/` | `tools/`, `tests/`, `apps/`, `docs/`, this README, `catalog.publish.yaml` |
| Neither | gitignored | GeoParquet, COGs, PMTiles, credentials |

`tools/s2_fetch.py` and `tools/s2_build.py` fetch and compact the parts,
`tools/s2_stats.py` builds the aggregates, and `tools/make_items.py`,
`tools/make_collection.py` and `tools/make_stats_collection.py` restamp the
metadata. `tools/publish.py` and `tools/upload_data.py` upload metadata and
data to the bucket. For how each collection stays in sync with Earth Search,
and how each was backfilled, see [`tools/README.md`](tools/README.md) under
"Sync & backfill". GitHub backfilled the first collection, and the RAILS
cluster backfilled Collection 1.

### Credentials

A workflow that writes to Source Cooperative assumes a role by OIDC and reads
its ARN from the repository variable `SOURCE_COOP_ROLE_ARN`. Source Cooperative
provisions that role per organization, so the value changes with the published
location and no workflow states it inline. Run `check-access` after setting it,
which round-trips a marker object and fails with a named error when the
variable is empty.

### Publish

```bash
python3 tools/publish.py            # dry run: what would change
python3 tools/publish.py --confirm  # upload; needs AWS credentials
```

It never deletes. Removing a file from `catalog/` does not unpublish it, so
delete the object yourself when that is what you meant. Data is staged at the
`data_dir` set in `catalog.publish.yaml`, and `tools/upload_data.py` uploads it
with the same dry-run and `--confirm` flags.

### Test

```bash
CI_LIGHT=1 python3 tests/run_all.py
```

| Gate | What it checks |
|---|---|
| `test_links.py` | Each relative link and asset href resolves |
| `test_location.py` | Each URL points at the configured published location |
| `test_publish.py` | Nothing outside `catalog/` can be uploaded |
| `test_upload_data.py` | Only staged files with an allowed suffix upload |
| `test_stac_valid.py` | Valid STAC 1.1.0, via `stac-check` |
| `test_conformance.py` | Portolan conformance, via `rashid` |

`CI_LIGHT=1` exempts asset hrefs with a data suffix from `test_links.py`, which
is the normal case when the data bytes are absent from this machine. Each
structural link is still checked. The unit tests for the tools run under
`CI_LIGHT=1 python3 -m pytest tests/ -q`. They need `duckdb`, the build test
needs `geoparquet-io==1.5.0` on the PATH, and `tests/test_fetch.py` compares
UTC instants, so run it with `TZ=UTC`. `tools/s2_build.py` needs
`geoparquet-io` 1.4 or newer for `--compression-level` and `--write-memory`.

CI runs `rashid`, `stac-check` and `tests/run_all.py` on each pull request.
`docs/conformance.md` records any accepted deviation, with the rule, the reason
and the tracking issue. The allow-list in `tests/test_conformance.py` never
widens without a matching row there.

### Contributing

Open an issue at
https://github.com/taylor-geospatial/s2-stac-geoparquet/issues for wrong
metadata, a query that should be cheaper, or a column that needs explaining.
Pull requests against `catalog/` are welcome, and CI runs the gates above on
them.

## License

Sentinel-2 imagery and its derived products fall under the
[Copernicus Sentinel Data Terms and Conditions](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice),
which grant free, full and open access (SPDX `CC-BY-SA-3.0-IGO`). Contains
modified Copernicus Sentinel data. See
[`catalog/README.md`](catalog/README.md) for the citation the AWS Registry of
Open Data asks for. For the repository code, see `LICENSE`.
