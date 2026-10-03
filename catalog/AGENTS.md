# Agent guide

Guidance for AI agents and automated clients working with the Sentinel-2 L2A
STAC-GeoParquet mirror.

**One rule governs each edit to this file.** A claim here is either quoted
from a source or measured from the data. If you cannot point at where a fact
came from, it does not belong in this file. An agent acting on an invented
column name or an invented join key produces a confident wrong answer that
nothing downstream catches.

## Where things are

| Resource | URL |
|---|---|
| STAC root | `https://data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json` |
| Data prefix, https | `https://data.source.coop/tge-labs/s2-stac-geoparquet/` |
| Data prefix, s3 (anonymous, glob-able) | `s3://us-west-2.opendata.source.coop/tge-labs/s2-stac-geoparquet/` |
| Human catalog page | https://source.coop/tge-labs/s2-stac-geoparquet |
| Visual browser | [Portolan browser](https://browser.portolan-sdi.org/#/external/data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json) |
| Interactive explorer | https://research.taylorgeospatial.org/s2-stac-geoparquet/ |
| Upstream STAC API | https://earth-search.aws.element84.com/v1 |
| Repository and issues | https://github.com/taylor-geospatial/s2-stac-geoparquet |

Prefer `https://` for one file you can name, and `s3://` when you need
DuckDB to expand a `year=*/*.parquet` glob. DuckDB refuses a glob over plain
`https://`.

## The collections

This catalog publishes two item indexes, each with a stats collection beside
it.

`sentinel-2-c1-l2a` mirrors Earth Search's Sentinel-2 Collection 1 index, which
is ESA's reprocessing of the archive. It is sorted tile-major and joined on
`_tile` rather than `s2:mgrs_tile`. Its `collection.json` counted 30,402,025
rows, 2015-10 to 2026-09, when read on 2026-09-22. `stats-c1` aggregates its
MGRS-tile statistics. Query Collection 1 first, because it is the uniform
record. Upstream:
[Earth Search `sentinel-2-c1-l2a`](https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a).

`sentinel-2-l2a` mirrors the original Earth Search Sentinel-2 L2A item index as
year-partitioned STAC-GeoParquet. Earth Search counted 51.25 million items on
2026-09-15. `stats` aggregates its MGRS-tile statistics. Upstream:
[Earth Search `sentinel-2-l2a`](https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a).

Read the agent guide of the collection you query before you query it. Each one
documents its schema, its query pattern, the NULLs to expect and the contract
for the `assets` JSON-string column. This page repeats none of that.

- [`sentinel-2-c1-l2a/AGENTS.md`](sentinel-2-c1-l2a/AGENTS.md)
- [`stats-c1/AGENTS.md`](stats-c1/AGENTS.md)
- [`sentinel-2-l2a/AGENTS.md`](sentinel-2-l2a/AGENTS.md)
- [`stats/AGENTS.md`](stats/AGENTS.md)

## Coverage

Coverage in `sentinel-2-l2a` is partial before December 2018, with no items for
2015 and 2016 and part of 2017 and 2018. That gap belongs to Earth Search's
record. Do not report a missing year as an observation about Sentinel-2 itself.
`sentinel-2-c1-l2a` reaches back to October 2015 instead, because ESA
reprocessed the archive to one baseline.

This catalog mirrors its upstream. Earth Search, run by
[Element 84](https://element84.com/) on the AWS Registry of Open Data, produces
the item index republished here, and no step in this pipeline filters,
reclassifies or interpolates it.

## Structure

Assets and structural links resolve relative to the object that carries them.
Catalogs here publish no `self` link, so a client tracks its own location.
