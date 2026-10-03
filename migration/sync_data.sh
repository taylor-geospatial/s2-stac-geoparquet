#!/usr/bin/env bash
#
# Copy the published objects from the retired location to the current one.
#
#   old: s3://portolan-mirrors/sentinel-2-catalog/
#   new: s3://tge-labs/s2-stac-geoparquet/
#
# Both go through the Source Cooperative gateway at https://data.source.coop.
# At that gateway the organization is the bucket and the product is the first
# key segment. This is not the raw AWS bucket named in catalog.publish.yaml.
# The gateway accepts the credentials the `source-coop` CLI issues, and one
# set of them reads the retired repository and writes the current one.
#
# This script defaults to a dry run. It copies nothing until you pass
# --confirm.
#
#   bash migration/sync_data.sh                 # inventory and plan
#   bash migration/sync_data.sh --confirm       # copy
#   bash migration/sync_data.sh --verify        # compare the two repositories
#
# What the gateway does not do, measured on 2026-10-03:
#
#   * No UploadPartCopy. A server-side copy must fit one CopyObject call,
#     which S3 caps at 5 GB. This script raises multipart_threshold to 5 GB
#     so every smaller object copies server-side, and skips the larger ones.
#   * No GetObjectTagging. The default --copy-props calls it and gets a 500,
#     so every copy here passes --copy-props none.
#   * No large single PutObject. A 300 MB PutObject gets a 413, so the
#     streaming leg uses multipart upload.
#
# Run migration/stream_oversized.sh for the objects above 5 GB.
#
set -euo pipefail

EP="https://data.source.coop"
OLD="s3://portolan-mirrors/sentinel-2-catalog"
NEW="s3://tge-labs/s2-stac-geoparquet"
WORK="${TMPDIR:-/tmp}/s2-migration"
mkdir -p "$WORK"

# The 5 GB CopyObject cap, in bytes.
CAP=5368709120

MODE="plan"
for arg in "$@"; do
  case "$arg" in
    --confirm) MODE="copy" ;;
    --verify)  MODE="verify" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# The CLI issues temporary credentials and refreshes them when they expire.
# credential_process keeps the secret out of this file and off the terminal.
cat > "$WORK/awsconfig" <<'EOF'
[profile s2mig]
region = us-west-2
credential_process = source-coop creds --format credential-process
s3 =
    multipart_threshold = 5GB
    multipart_chunksize = 64MB
    max_concurrent_requests = 16
EOF
export AWS_CONFIG_FILE="$WORK/awsconfig"

g() { aws --profile s2mig --region us-west-2 --endpoint-url "$EP" "$@"; }

echo "gateway : $EP"
echo "old     : $OLD/"
echo "new     : $NEW/"
echo

# --- preflight --------------------------------------------------------------
# sts:GetCallerIdentity is not in scope for these credentials, so the check
# is a read on the source and a round-tripped object on the destination.

echo "== preflight =="
if ! g s3 ls "$OLD/" > /dev/null; then
  echo "FAIL: cannot read the retired repository." >&2
  echo "      Run: source-coop login" >&2
  exit 1
fi
echo "read  old: ok"

PROBE="$NEW/_migration-probe"
if ! printf 'probe\n' | g s3 cp - "$PROBE" > /dev/null 2>&1; then
  echo "FAIL: cannot write the current repository." >&2
  echo "      The product tge-labs/s2-stac-geoparquet must exist, and the" >&2
  echo "      logged-in account must be able to write it." >&2
  exit 1
fi
g s3 rm "$PROBE" > /dev/null
echo "write new: ok"
echo

# --- split the inventory at the CopyObject cap ------------------------------

g s3 ls "$OLD/" --recursive | awk '{print $3"\t"$4}' > "$WORK/src.tsv"
awk -F'\t' -v cap="$CAP" '$1 >  cap' "$WORK/src.tsv" > "$WORK/over.tsv"
awk -F'\t' -v cap="$CAP" '$1 <= cap' "$WORK/src.tsv" > "$WORK/under.tsv"

bytes=$(awk -F'\t' '{s+=$1} END {printf "%.1f", s/1073741824}' "$WORK/src.tsv")
echo "source: $(wc -l < "$WORK/src.tsv" | tr -d ' ') objects, ${bytes} GB"
echo "  server-side copy (<= 5 GB): $(wc -l < "$WORK/under.tsv" | tr -d ' ')"
echo "  needs streaming  (>  5 GB): $(wc -l < "$WORK/over.tsv" | tr -d ' ')"
if [ -s "$WORK/over.tsv" ]; then
  awk -F'\t' '{printf "    %.2f GB  %s\n", $1/1073741824, $2}' "$WORK/over.tsv"
fi
echo

# Build the --exclude flags for the oversized objects.
EXCL=()
while IFS=$'\t' read -r _ key; do
  EXCL+=("--exclude" "${key#sentinel-2-catalog/}")
done < "$WORK/over.tsv"

case "$MODE" in
  plan)
    echo "== planned copy (dry run, first 40) =="
    g s3 sync "$OLD/" "$NEW/" --copy-props none "${EXCL[@]}" --dryrun \
      | head -40
    echo
    echo "Re-run with --confirm to copy, then run stream_oversized.sh."
    ;;

  copy)
    echo "== copying server-side =="
    echo "start $(date -u +%H:%M:%SZ)"
    # A read timeout here does not mean the copy failed. The gateway can
    # finish a multi-GB CopyObject after the client stops waiting, so
    # --verify is what decides whether an object arrived.
    g s3 sync "$OLD/" "$NEW/" --copy-props none "${EXCL[@]}" \
      --only-show-errors || true
    echo "end   $(date -u +%H:%M:%SZ)"
    echo
    echo "Now run: bash migration/stream_oversized.sh --confirm"
    echo "Then:    bash migration/sync_data.sh --verify"
    ;;

  verify)
    echo "== verify =="
    g s3 ls "$OLD/" --recursive | awk '{print $3"  "$4}' \
      | sed 's|  sentinel-2-catalog/|  |' | sort > "$WORK/a"
    g s3 ls "$NEW/" --recursive | awk '{print $3"  "$4}' \
      | sed 's|  s2-stac-geoparquet/|  |' | sort > "$WORK/b"

    echo "old objects: $(wc -l < "$WORK/a" | tr -d ' ')"
    echo "new objects: $(wc -l < "$WORK/b" | tr -d ' ')"
    echo

    missing=$(comm -23 "$WORK/a" "$WORK/b")
    extra=$(comm -13 "$WORK/a" "$WORK/b")

    if [ -z "$missing" ] && [ -z "$extra" ]; then
      echo "PASS: every object is present at the same size."
      exit 0
    fi
    [ -n "$missing" ] && { echo "missing or wrong size:"; echo "$missing"; }
    [ -n "$extra" ] && { echo "only at the destination:"; echo "$extra"; }
    exit 1
    ;;
esac
