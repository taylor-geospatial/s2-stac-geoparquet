# Portolan Conformance

Conformance means passing [rashid](https://github.com/portolan-sdi/rashid),
not claiming to conform, so it runs in CI:

```bash
python3 tests/test_conformance.py
```

That gate fails on any error-severity finding whose rule is not listed below.
The list starts empty and it must never grow without a row here. A known
deviation with an issue number is a debt someone can pay off. A silently
widened allow-list is a false claim about what this catalog conforms to.

## The profile version

This catalog declares Portolan v0.3.0:

```
https://schemas.portolan-sdi.org/portolan/v0.3.0/schema.json
```

Every catalog and collection carries that one string (PORTO-CORE-006,
PORTO-CORE-009). rashid reads the version from the root catalog and reports
every object that declares a different one as PTL-CNF-002. The string is a
constant in `tools/make_collection.py`, named `PORTOLAN_SCHEMA`, because the
version has to track a reviewed spec release and not an installed dependency.
`catalog/catalog.json` and the two `catalog/stats*/collection.json` files are
committed rather than generated, so they carry the same string by hand.

## The rashid version floor

The gate needs rashid `>=0.4.0,<0.5.0`. It reads `rashid --version` and fails
outside that range. It also fails when rashid is absent, and prints the install
command. A skip would report a green run for a catalog that no validator read.

The floor is 0.4.0 because that is the first rashid that bundles the v0.3.0
profile. PTL-AST-009 (PORTO-FMT-062) and PTL-AST-010 (PORTO-CORE-088) are new
in that rule set. An older rashid reports a pass for a catalog that it never
checked against them. The same range is in the CI install step and in every
publishing workflow, so a publish validates with the same rashid as a pull
request.

The upper bound stops an unreviewed 0.5 rule set from changing what this gate
means. Raise both bounds together when you move to 0.5, and read the new rules
first.

This file also records workarounds for the other validator CI runs. Those are
not conformance debts, because the catalog is correct and the validator is not.
They live here so nobody has to read CI code to find out why a gate skips
something.

## Accepted deviations

| Rule | Where | Why accepted | Tracking |
|---|---|---|---|
| PTL-AST-009 | `stats`, `stats-c1` | The GeoParquet behind `mgrs.pmtiles` is a build intermediate that `tools/s2_stats.py` deletes, so neither collection references it. The fix uploads a data file, which no metadata change can do. | [#39](https://github.com/taylor-geospatial/s2-stac-geoparquet/issues/39) |

### PTL-AST-009: the PMTiles has no GeoParquet beside it

PORTO-FMT-062, new in v0.3.0, says a PMTiles asset must carry the `visual`
role and must belong to a collection that references its source GeoParquet.
Both stats collections carry the role. Neither references a GeoParquet file:
`mgrs-monthly.parquet` and `timeline.parquet` are plain Parquet with no
geometry column and no `geo` key, which a footer read over HTTP confirms.

`tools/s2_stats.py` writes the tile envelopes as `mgrs-tiles.parquet`, feeds
the file to `gpio pmtiles create`, and then deletes it. The tool already takes
`--keep-footprint-table`. Issue #39 holds the four steps that close this, and
the last two remove the row above and the id from `ACCEPTED`.

<!--
When you accept one, add a row and a section explaining it, like the row
above. Then add the rule id to ACCEPTED in tests/test_conformance.py. Both, or
neither.
-->

## Warnings this catalog does not clear

The gate fails on error severity only. These warnings stay, and each one has a
reason. No allow-list hides them: `rashid check catalog/` prints them on every
run.

| Rule | Count | Why it stays |
|---|---|---|
| PTL-AST-003 | 83 | A data asset carries `file:size` and no `file:checksum`. A checksum needs every byte, and the parts the committed items describe total 62 GB. `tools/make_items.py` reads the size from one HEAD request instead. PORTO-CORE-028 is a SHOULD. |
| PTL-DAT-007 | 2 | The parts carry native `GeospatialStatistics` per row group, which meets the MUST in PORTO-FMT-007. They carry no `bbox` `covering` column, which PORTO-FMT-008 recommends for page-level pruning. [#40](https://github.com/taylor-geospatial/s2-stac-geoparquet/issues/40) tracks the rewrite. |
| PTL-DAT-006 | 2 | The incubating spatial-order method scores 3 early `sentinel-2-l2a` parts and one 6-row-group part below its bar. Every `sentinel-2-l2a` year before 2026 sorts by `(_month, _hilbert)`, which is a spatial order inside each month and meets PORTO-FMT-006. The method is not part of the conformance surface, and rashid reports it as a warning. |
| PTL-PRO-002 | 2 | `stats` and `stats-c1` hold aggregates that this repository computes. ESA produces the source products, so rashid reads the collections as mirrors. No upstream STAC object describes the aggregates, so there is nothing to link with `rel: canonical`. Severity is info. |

## The incubating STAC-GeoParquet catalog index

Portolan v0.3.0 ships an incubating profile for a catalog index: one
GeoParquet file, `collections.parquet`, with one row per catalog and per
collection, linked from the root with `rel: "data"` and type
`application/vnd.apache.parquet`. The profile is experimental and its columns
can change with upstream.

This catalog holds 4 collections, so the index saves a client 4 fetches. It
also needs a generator and an upload, which a metadata change cannot do. The
catalog does not publish one today. Revisit this when the layout settles in
[stac-geoparquet-spec#17](https://github.com/radiantearth/stac-geoparquet-spec/issues/17).

## Validator workarounds

### stac-check reports a dialect crash on every collection

`tests/test_stac_valid.py` exempts one stac-check failure:

```
'list' object has no attribute 'get'
[Schema: https://schemas.portolan-sdi.org/portolan/vX.Y.Z/schema.json]. Error in Extensions.
```

The Portolan schema is valid draft-07, and rashid validates catalogs against it
cleanly. `stac-validator`, which stac-check uses, hardcodes the JSON Schema
2020-12 dialect and ignores the `$schema` a schema declares. The profile schema
uses the draft-07 tuple form of `items` in `valid_bbox`, which means something
different under 2020-12, so the library raises instead of validating.

Tracked upstream at <https://github.com/stac-utils/stac-check/issues/159>,
and on the Portolan side at
<https://github.com/portolan-sdi/portolan-spec/issues/157>.

The exemption matches that exact message, and only when the failing schema is a
Portolan profile schema. Every other stac-check error still fails the build,
and the gate prints how many objects took the exemption.

The exemption expires on its own. The gate fails once stac-check stops emitting
the crash on a collection or item that declares the profile schema, and tells
you to delete both the exemption and this section. CI installs stac-check
unpinned, so the next release triggers that without anyone watching for it.

`tests/test_stac_valid.py` also fails when stac-check is absent, and prints the
install command. It takes no version floor and no pin. The rashid floor exists
because that gate asserts four named rules. This gate asserts no stac-check
rule. It needs the opposite property. A pin holds the exemption open after the
upstream fix ships.
