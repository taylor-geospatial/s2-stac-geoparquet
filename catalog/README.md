# Sentinel-2 L2A STAC-GeoParquet mirror

Every Sentinel-2 L2A scene that AWS Earth Search indexes, republished as
cloud-native GeoParquet you query in place over HTTP. No API and no key stand
between a client and the data.

## Ways in

| To do this | Go here |
|---|---|
| Search scenes on a map, and draw any band from its COGs in the browser | [Scene explorer](https://research.taylorgeospatial.org/s2-stac-geoparquet/) |
| Browse the collections, their items and their assets | [Portolan browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json) |
| Read the catalog page and list the published files | [Source Cooperative](https://source.coop/tge-labs/s2-stac-geoparquet) |
| Fetch the metadata root | [`catalog.json`](https://data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json) |
| Query it as an agent | [`AGENTS.md`](AGENTS.md) |
| Report a problem or send a change | [Issues](https://github.com/taylor-geospatial/s2-stac-geoparquet/issues), [repository](https://github.com/taylor-geospatial/s2-stac-geoparquet) |

The explorer opens on Collection 1. Its sidebar switch, or
[`?collection=sentinel-2-l2a`](https://research.taylorgeospatial.org/s2-stac-geoparquet/?collection=sentinel-2-l2a),
shows the original index on the same page.

Earth Search, run by [Element 84](https://element84.com/) on the
[AWS Registry of Open Data](https://registry.opendata.aws/sentinel-2-l2a-cogs/),
produces the item indexes this catalog republishes, and Copernicus Sentinel-2
is the imagery behind them. This catalog mirrors those indexes without
filtering, reclassifying or interpolating anything in them.

## The collections

No imagery is published here. The Sentinel-2 Cloud-Optimized GeoTIFFs remain in
their AWS buckets, and each item row reproduces their URLs verbatim. What
publishes here is the item index, one GeoParquet row per scene, with small
per-MGRS-tile aggregates that make it practical to plan a query before running
it.

| Collection | Contents | Browse | Upstream |
|---|---|---|---|
| [`sentinel-2-c1-l2a`](sentinel-2-c1-l2a/README.md) | **Collection 1**, ESA's uniform reprocessing of the archive. 30 million scenes from 2015 on, one `items.parquet` per year. Start here, and the explorer does too. | [browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/collection.json) · [explorer](https://research.taylorgeospatial.org/s2-stac-geoparquet/) | [Earth Search collection](https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a) |
| [`stats-c1`](stats-c1/README.md) | MGRS tile by month aggregates over Collection 1, and a tile-footprint tileset. | [browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/stats-c1/collection.json) | derived here |
| [`sentinel-2-l2a`](sentinel-2-l2a/README.md) | The **original** Earth Search index. 51 million scenes from November 2016 on, in zone-partitioned year parts. Its record reflects Earth Search's own history, including duplicate items in early years. | [browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-l2a/collection.json) · [explorer](https://research.taylorgeospatial.org/s2-stac-geoparquet/?collection=sentinel-2-l2a) | [Earth Search collection](https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a) |
| [`stats`](stats/README.md) | The same aggregates over the original index. | [browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/stats/collection.json) | derived here |

Each collection's `table:row_count` and temporal extent state what it includes
right now, and each `year=YYYY/YYYY.json` item states its year's. Those fields
are the authority, where this page describes what is mirrored and how to read
it.

Each collection has a README and an agent guide beside it:
[`sentinel-2-c1-l2a`](sentinel-2-c1-l2a/README.md)
([agents](sentinel-2-c1-l2a/AGENTS.md)),
[`stats-c1`](stats-c1/README.md) ([agents](stats-c1/AGENTS.md)),
[`sentinel-2-l2a`](sentinel-2-l2a/README.md)
([agents](sentinel-2-l2a/AGENTS.md)), and
[`stats`](stats/README.md) ([agents](stats/AGENTS.md)).

## Access

A client reads the Parquet over HTTP, with range requests, straight from the
bucket:

```sql
INSTALL httpfs; LOAD httpfs;
SET TimeZone = 'UTC';

SELECT id, datetime, "eo:cloud_cover" AS cloud
FROM read_parquet('https://data.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=2025/items.parquet')
WHERE _tile = '31UFU'
  AND "eo:cloud_cover" <= 10
ORDER BY "eo:cloud_cover" LIMIT 10;
```

The parts are sorted by tile, so a tile filter reads a few row groups instead
of the file. To scan many years at once, use the anonymous `s3://` door with a
glob, because DuckDB can list a bucket but cannot expand a glob over plain
`https://`:

```sql
SET s3_region = 'us-west-2';
SET s3_url_style = 'path';

SELECT year, count(*) AS scenes
FROM read_parquet('s3://us-west-2.opendata.source.coop/tge-labs/s2-stac-geoparquet/sentinel-2-c1-l2a/year=*/items.parquet',
                  hive_partitioning = true)
GROUP BY year ORDER BY year;
```

The collection READMEs give the full query patterns, including the one that
finds cloud-free scenes over a field and the COG URL for each.

## Provenance

Each item comes from the
[Earth Search STAC API](https://earth-search.aws.element84.com/v1), fetched and
normalized to one schema per collection. Months the API could not serve during
its outage windows were read instead from the static item JSON in the
`sentinel-cogs` bucket, which contains the same items. Each archive is one
queryable table, and a row means the same thing in 2019 as it does today.

Column meanings and query patterns are documented per collection, in
[`sentinel-2-c1-l2a`](sentinel-2-c1-l2a/README.md) and
[`sentinel-2-l2a`](sentinel-2-l2a/README.md), each with an agent guide beside
it.

## License

Sentinel-2 data and its derivatives fall under the
[Copernicus Sentinel Data Terms and Conditions](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice),
which grant free, full and open access for any use (SPDX `CC-BY-SA-3.0-IGO`).
The citation for the upstream COGs, from their
[AWS Registry of Open Data entry](https://registry.opendata.aws/sentinel-2-l2a-cogs/):

> Sentinel-2 Cloud-Optimized GeoTIFFs, accessed on [DATE] from
> https://registry.opendata.aws/sentinel-2-l2a-cogs.

Cite this catalog itself as the item index derived from that archive. Contains
modified Copernicus Sentinel data.
