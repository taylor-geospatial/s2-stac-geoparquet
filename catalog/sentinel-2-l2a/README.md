# Sentinel-2 L2A scenes (item index)

Every Sentinel-2 L2A scene that AWS Earth Search publishes, as one
year-partitioned GeoParquet table you can query in place. A row is one scene.
It states the footprint, the acquisition time, the MGRS tile, the cloud cover,
the scene-classification percentages, and the complete upstream STAC `assets`
object.

| To do this | Go here |
|---|---|
| Search these scenes on a map, and draw their bands | [Scene explorer](https://research.taylorgeospatial.org/s2-stac-geoparquet/?collection=sentinel-2-l2a) |
| Browse this collection, its items and its assets | [Portolan browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-l2a/collection.json) |
| Fetch this collection's metadata | [`collection.json`](https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-l2a/collection.json) |
| Read the upstream STAC collection | [Earth Search `sentinel-2-l2a`](https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a) |
| Query it as an agent | [`AGENTS.md`](AGENTS.md) |
| See the whole catalog | [catalog README](../README.md), [Source Cooperative](https://source.coop/tge-labs/s2-stac-geoparquet) |

For most work, prefer
[`sentinel-2-c1-l2a`](../sentinel-2-c1-l2a/README.md), ESA's uniform
reprocessing of the archive. This collection mirrors Earth Search's original
index, which reaches back only to November 2016 and repeats many early scenes.

This catalog publishes no imagery. The Cloud-Optimized GeoTIFFs remain in the
public `sentinel-cogs` bucket on AWS, and the table already reproduces each of
their URLs.

## Query it

```sql
-- Cloud-free scenes over a field during harvest, no API, no rate limits.
INSTALL httpfs; LOAD httpfs;
SET TimeZone = 'UTC';

SELECT id, datetime, "eo:cloud_cover", thumbnail_url,
       json_extract_string(assets, '$.visual.href') AS visual_cog
FROM read_parquet('https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-l2a/year=2021/z21-31.parquet')
WHERE "s2:mgrs_tile" = '31UFU'
  AND _month BETWEEN 8 AND 10
  AND datetime BETWEEN '2021-08-01' AND '2021-10-15 23:59:59'
  AND "eo:cloud_cover" < 10
ORDER BY "eo:cloud_cover", id LIMIT 20;
```

Every asset href is in the `assets` JSON-string column — no URL templates, no
API. Swap `$.visual.href` for `$.red.href`, `$.scl.href` or any other key; the
[agent guide](AGENTS.md) lists them all.

That query is cheap for three reasons together. A tile id and a year
identify the part, so `31UFU` is zone 31 and 2021 is `z21-31.parquet`, and the
Layout section below gives every range. Rows inside each part sort by month
first, as `(_month, _hilbert)` through 2025 and `(_month, s2:mgrs_tile,
_hilbert)` from 2026, so a month filter and a spatial filter both prune row
groups. The answer comes entirely from HTTP range requests against the Parquet
files, with no API in front to queue behind.

This collection sets `partition:glob` to `year=*/*.parquet`, a Hive layout.
Setting `hive_partitioning = true` exposes `year` as a column the files
themselves omit, and a filter on it skips whole files. DuckDB expands the glob
when it can list the store, which the anonymous `s3://` door allows. Over plain
`https://` it reports "Globs (`*`) for generic HTTP file are not supported", so
name the part as above. A year-pruned count through the glob:

```sql
INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-west-2';
SET s3_url_style = 'path';
SET TimeZone = 'UTC';

SELECT year, count(*) AS scenes, min(datetime) AS first, max(datetime) AS last
FROM read_parquet('s3://us-west-2.opendata.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-l2a/year=*/*.parquet',
                  hive_partitioning = true)
WHERE year IN (2016, 2017)
GROUP BY year ORDER BY year;
```

That opens two parts out of sixty and reads their footers. A scan of every
part takes minutes rather than seconds, and this collection's
`table:row_count` and temporal extent give the whole-archive answer without
one.

## Layout

```
sentinel-2-l2a/
  collection.json
  year=2016/items.parquet      one file per year through 2018
  year=2017/items.parquet
  year=2018/items.parquet
  year=2019/z01-20.parquet     four files per year for 2019-2020, by UTM zone
  year=2019/z21-35.parquet
  year=2019/z36-46.parquet
  year=2019/z47-60.parquet
  year=2020/z01-20.parquet … z47-60.parquet
  year=2021/z01-15.parquet     eight files per year from 2021, by UTM zone
  year=2021/z16-20.parquet
  year=2021/z21-31.parquet
  year=2021/z32-35.parquet
  year=2021/z36-40.parquet
  year=2021/z41-46.parquet
  year=2021/z47-52.parquet
  year=2021/z53-60.parquet
  …
  year=2026/z01-15.parquet … z53-60.parquet
  year=2026/live.parquet       rolling tail since the last consolidation
```

One directory per year Earth Search actually holds items for, so the listing
starts where its record does — see Coverage below.

A year's archive is one file through 2018, and from 2019 it is split by the
UTM zone of `s2:mgrs_tile` (the leading digits of the tile id). 2019 and 2020
are four files: `z01-20.parquet` holds zones 1–20, `z21-35.parquet` zones
21–35, `z36-46.parquet` zones 36–46, `z47-60.parquet` zones 47–60. From 2021 a
year is eight, nested inside those four: `z01-15.parquet` (zones 1–15),
`z16-20.parquet` (16–20), `z21-31.parquet` (21–31), `z32-35.parquet` (32–35),
`z36-40.parquet` (36–40), `z41-46.parquet` (41–46), `z47-52.parquet` (47–52),
`z53-60.parquet` (53–60). The split is what keeps an 8-million-scene year
buildable, and it is also a spatial index for free: a tile id and a year name
the part, so a query for `31UFU` in 2021 can open `year=2021/z21-31.parquet`
alone and skip the other seven eighths of the year. The current year also carries
`live.parquet`, rebuilt daily from the Earth Search API and folded into the
archive parts once a month. The daily rebuild drops every id the year's
archive parts already hold, so no two parts of a year overlap. A glob over
`year=*/*.parquet` therefore reads each scene exactly once and includes
yesterday, whichever shape the year has. A client can always dedupe on `id`
anyway; it is safe and it removes nothing.

Each `year=YYYY/YYYY.json` item states that year's measured row count, time
range, footprint bounds and platforms, so a client can choose a year without
opening a byte of Parquet. Each data asset in the item states the same for the
one part it names.

## Coverage

The record starts in November 2016, when Earth Search produced its first L2A
Cloud-Optimized GeoTIFFs: 2015 and most of 2016 have no COG products, and
2017-2018 are partial. That is what Earth Search serves. This mirror adds no
rows and drops none, so the gap is upstream, not here.

`sat:orbit_state` and `s2:granule_id` are NULL on newer items, because Earth
Search stopped populating them. Read the [agent guide](AGENTS.md) before you
write a query that depends on either.

## Provenance and license

Items come from the
[Earth Search STAC API](https://earth-search.aws.element84.com/v1), collection
`sentinel-2-l2a`, which Element 84 runs over the
[Sentinel-2 L2A COGs](https://registry.opendata.aws/sentinel-2-l2a-cogs/) on the
AWS Registry of Open Data. No step here filters, reclassifies or interpolates
the upstream record. The columns added are two sort helpers, `_month` and
`_hilbert`, documented in the [agent guide](AGENTS.md).

Contains modified Copernicus Sentinel data. The
[Copernicus Sentinel Data Terms and Conditions](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice)
grant free, full and open access for any use, and this collection states them
by their SPDX identifier, `CC-BY-SA-3.0-IGO`. The citation for the upstream
COGs, from their
[AWS Registry of Open Data entry](https://registry.opendata.aws/sentinel-2-l2a-cogs/):

> Sentinel-2 Cloud-Optimized GeoTIFFs, accessed on [DATE] from
> https://registry.opendata.aws/sentinel-2-l2a-cogs.
