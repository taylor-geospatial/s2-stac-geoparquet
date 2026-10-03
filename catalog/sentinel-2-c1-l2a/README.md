<!-- vale Portolan-Mechanics.Headings = NO -->
<!-- "Collection 1" is ESA's product designation, so it keeps its capital. -->
# Sentinel-2 Collection 1 L2A scenes (item index)
<!-- vale Portolan-Mechanics.Headings = YES -->

Every Sentinel-2 Collection 1 L2A scene that AWS Earth Search publishes, as one
year-partitioned GeoParquet table you can query in place. Collection 1 is ESA's
reprocessing of the whole Sentinel-2 archive to one processing baseline. Earth
Search indexes it as `sentinel-2-c1-l2a`, beside the older `sentinel-2-l2a`
this catalog also mirrors. A row is one scene. It states the footprint, the
acquisition time, the MGRS tile, the cloud cover, the scene-classification
percentages, the viewing and sun angles, the times Earth Search created and
last updated the item, and the complete upstream STAC `assets` object.

| To do this | Go here |
|---|---|
| Search these scenes on a map, and draw their bands | [Scene explorer](https://research.taylorgeospatial.org/s2-stac-geoparquet/) |
| Browse this collection, its items and its assets | [Portolan browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json) |
| Fetch this collection's metadata | [`collection.json`](https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json) |
| Read the upstream STAC collection | [Earth Search `sentinel-2-c1-l2a`](https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a) |
| Query it as an agent | [`AGENTS.md`](AGENTS.md) |
| See the whole catalog | [catalog README](../README.md), [Source Cooperative](https://source.coop/tge-labs/s2-stac-geoparquet) |

This catalog publishes no imagery. The Cloud-Optimized GeoTIFFs remain in the
public `e84-earth-search-sentinel-data` bucket on AWS, and the table already
reproduces each of their URLs.

Each year from 2015 on is published, with its own `year=YYYY/YYYY.json` item.
The `collection.json` counted 30,402,025 rows, 2015-10 to 2026-09, when read on
2026-09-22. This collection's `table:row_count` and temporal extent follow the
table at each publish, so [`collection.json`](collection.json) is the authority
on what is here.

## Query it

```sql
-- Cloud-free scenes over a field during harvest, with no API in the way.
INSTALL httpfs; LOAD httpfs;
SET TimeZone = 'UTC';

SELECT id, datetime, "eo:cloud_cover", thumbnail_url,
       json_extract_string(assets, '$.visual.href') AS visual_cog
FROM read_parquet('https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=2021/items.parquet')
WHERE _tile = '31UFU'
  AND datetime BETWEEN '2021-08-01' AND '2021-10-15 23:59:59'
  AND "eo:cloud_cover" < 10
ORDER BY "eo:cloud_cover", id LIMIT 20;
```

The `assets` JSON-string column already includes each asset href, so no URL
template and no API call are needed. Swap `$.visual.href` for `$.red.href`,
`$.scl.href`, `$.cloud.href` or any other key, which the
[agent guide](AGENTS.md) lists in full.

That query is cheap for three reasons together. A year identifies the file,
because `year=2021/items.parquet` is the only archive part for 2021, so the
query opens one object. Rows inside it sort by `(_tile, datetime)`, which makes
`31UFU`'s whole year one contiguous run, so the tile filter selects the one or
two row groups covering that run and the date window then trims it. The answer
comes entirely from HTTP range requests against the Parquet file, with no API
in front to queue behind.

This collection sets `partition:glob` to `year=*/*.parquet`, a Hive layout.
Setting `hive_partitioning = true` exposes `year` as a column the files
themselves omit, and a filter on it skips whole files. DuckDB expands the glob
when it can list the store, which the anonymous `s3://` door allows. Over plain
`https://` it reports "Globs (`*`) for generic HTTP file are not supported", so
name the file as above. A year-pruned count through the glob:

```sql
INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-west-2';
SET s3_url_style = 'path';
SET TimeZone = 'UTC';

SELECT year, count(*) AS scenes, min(datetime) AS first, max(datetime) AS last
FROM read_parquet('s3://us-west-2.opendata.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=*/*.parquet',
                  hive_partitioning = true)
WHERE year IN (2017, 2018)
GROUP BY year ORDER BY year;
```

That opens the two matching files and reads their footers. A scan of every file
takes minutes rather than seconds, and this collection's `table:row_count` and
temporal extent give the whole-archive answer without one.

## Layout

```
sentinel-2-c1-l2a/
  collection.json
  year=2015/items.parquet      one file per year, every year
  year=2016/items.parquet
  …
  year=2026/items.parquet
  year=2026/live-09.parquet    rolling tail since the last fold, one file per
  year=2026/live-10.parquet    month of the year; any year may have some
```

One directory exists per year that Earth Search indexes Collection 1 items
for, from 2015 on. Coverage below gives the counts and how they keep changing.

A year's archive is one `items.parquet`, whatever its size, because this
collection is built on a compute cluster rather than inside a CI job and needs
no zone split. Rows sort by `(_tile, datetime)`, which is tile-major, so one
tile's year is one contiguous run in acquisition order. A tile-and-window query
then reads the one or two row groups covering that run instead of a group per
month. Row groups are uniform at a target of 6,000 rows, which DuckDB writes as
6,144, small enough that a tile lookup fetches little beyond its own rows.

The search-latency experiments behind
[issue #9](https://github.com/taylor-geospatial/s2-stac-geoparquet/issues/9)
measured this layout as the fastest for tile-window searches. The month-major
sort of the older `sentinel-2-l2a` parts scatters a tile's year across twelve
month sections, so a three-month window there admits six or seven row groups
where this layout admits one or two. `_month` and `_hilbert` remain columns, so
a month filter or a Hilbert-range filter still works, and they no longer set
the order. The files are GeoParquet 2.0, with a native `GEOMETRY` column and
per-row-group geo statistics, at zstd level 18.

Any year, rather than only the current one, may also include live files, one
per month of it, from `live-01.parquet` to `live-12.parquet`, where `MM` is the
month the scene was acquired in. ESA's reprocessing is still running, so scenes
from old years keep appearing with recent `created` timestamps. The daily
refresh looks back on `created` rather than `datetime`, and appends what it
finds to the live file of the month and year each scene belongs to. Those live
files use zstd level 3, which compresses faster than the level 18 the archive
parts use.

One file per month is what bounds the cost of that write as the tail grows,
because a day of refresh rewrites and re-uploads only the months it fetched, in
steady state one. One tail file instead gained about 15,000 rows a day for as long as
the next fold took. A year refreshed before those files existed may also
include an empty `live.parquet`, which once held the whole tail, and it is kept
at zero rows because this catalog never deletes a published file.

Every month or two, and at year end, a fold job merges each live file of a year
into its `items.parquet`, re-sorted by tile and time at zstd 18, and empties
each one. Between folds, a glob over `year=YYYY/*.parquet` reads the archive
plus the tail. The parts do not overlap except for a reprocessed scene, which
keeps its id with a newer `s2:generation_time`, so dedupe on `id` keeping the
highest generation time to get the year exactly once.

Each `year=YYYY/YYYY.json` item states that year's measured row count, time
range, footprint bounds and platforms, so a client can choose a year without
opening a byte of Parquet. Each data asset in the item states the same for the
one file it references.

## Coverage

Earth Search's `sentinel-2-c1-l2a` held 30,391,138 items when it was counted on
2026-09-21, by year of acquisition:

| Year | Items | Year | Items |
| --- | ---: | --- | ---: |
| 2015 | 200 | 2021 | 4,055,717 |
| 2016 | 222 | 2022 | 283,705 |
| 2017 | 24,664 | 2023 | 4,249,728 |
| 2018 | 1,329,973 | 2024 | 4,369,942 |
| 2019 | 3,166,919 | 2025 | 5,065,361 |
| 2020 | 4,013,725 | 2026 | 3,830,982 (to date) |

Those counts belong to the source rather than to this mirror, and they keep
moving. ESA reprocesses the archive year by year, so a small year such as 2015
to 2017, or 2022 at a fraction of its neighbours, marks where the reprocessing
has yet to finish. Sentinel-2 acquired normally in each of them. The counts
grow as the reprocessing proceeds, and the growth arrives with recent `created`
timestamps, so the refresh looks back on that field. Read the
per-year items for what is published, and treat a thin year as a statement
about the reprocessing rather than about the mission.

`s2:dark_features_percentage` is NULL on every scene processed at baseline
05.11 or later, because ESA dropped the class, and it is present on 05.00 to
05.10. `created` and `updated` are Earth Search's ingest times rather than
anything about the acquisition.

## Provenance and license

Items come from the
[Earth Search STAC API](https://earth-search.aws.element84.com/v1), collection
[`sentinel-2-c1-l2a`](https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a),
which Element 84 runs over the Collection 1 COGs it produces into
`e84-earth-search-sentinel-data`, listed on the
[AWS Registry of Open Data](https://registry.opendata.aws/sentinel-2-l2a-cogs/).
Each asset is at
`https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/<zone>/<band>/<sq>/<year>/<month>/<id>/`,
such as `31/U/ET/2026/9/S2B_T31UET_20260921T105030_L2A/`, with the
thumbnail as `L2A_PVI.jpg` in that directory. Read the href from `assets`
rather than building it. No step here filters, reclassifies or interpolates the
upstream record. The columns added are four helpers, `thumbnail_url`, `_month`,
`_hilbert` and `_tile`, documented in the [agent guide](AGENTS.md).

Contains modified Copernicus Sentinel data. The
[Copernicus Sentinel Data Terms and Conditions](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice)
grant free, full and open access for any use, and this collection states them
by their SPDX identifier, `CC-BY-SA-3.0-IGO`. The citation for the upstream
COGs, from their
[AWS Registry of Open Data entry](https://registry.opendata.aws/sentinel-2-l2a-cogs/):

> Sentinel-2 Cloud-Optimized GeoTIFFs, accessed on [DATE] from
> https://registry.opendata.aws/sentinel-2-l2a-cogs.
