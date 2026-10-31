#!/usr/bin/env bash
#
# Copy the objects that exceed the 5 GB CopyObject cap.
#
# The Source Cooperative gateway has no UploadPartCopy, so a server-side
# copy must fit one CopyObject call. S3 caps that at 5 GB. Each larger object
# therefore goes down to local disk and back up with multipart upload.
#
#   bash migration/stream_oversized.sh              # plan
#   bash migration/stream_oversized.sh --confirm    # copy
#
# Measured on 2026-10-03 from a laptop: 27 MB/s down and 25 MB/s up, so the
# two objects of this catalog take about 15 minutes together. One object is
# on disk at a time, so the peak disk use is the largest object.
#
set -euo pipefail

EP="https://data.source.coop"
OLD="s3://portolan-mirrors/sentinel-2-catalog"
NEW="s3://tge-labs/s2-stac-geoparquet"
WORK="${TMPDIR:-/tmp}/s2-migration"
BIG="$WORK/big"
CAP=5368709120
mkdir -p "$BIG"

CONFIRM=0
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# A small multipart threshold, because the gateway answers 413 to a large
# single PutObject. Multipart upload is supported; UploadPartCopy is not.
cat > "$WORK/awsconfig-stream" <<'EOF'
[profile s2mig_stream]
region = us-west-2
credential_process = source-coop creds --format credential-process
s3 =
    multipart_threshold = 64MB
    multipart_chunksize = 64MB
    max_concurrent_requests = 16
EOF
export AWS_CONFIG_FILE="$WORK/awsconfig-stream"

g() { aws --profile s2mig_stream --region us-west-2 --endpoint-url "$EP" "$@"; }

g s3 ls "$OLD/" --recursive | awk -v cap="$CAP" '$3 > cap {print $3"\t"$4}' \
  > "$WORK/over.tsv"

n=$(wc -l < "$WORK/over.tsv" | tr -d ' ')
if [ "$n" -eq 0 ]; then
  echo "No object exceeds 5 GB. Nothing to stream."
  exit 0
fi

echo "objects above the 5 GB cap: $n"
awk -F'\t' '{printf "  %.2f GB  %s\n", $1/1073741824, $2}' "$WORK/over.tsv"
echo

if [ "$CONFIRM" -eq 0 ]; then
  echo "Dry run. Re-run with --confirm to copy."
  exit 0
fi

while IFS=$'\t' read -r size key; do
  rel="${key#sentinel-2-catalog/}"
  local_file="$BIG/$(echo "$rel" | tr '/=' '__')"

  echo "=== $rel ==="
  echo "down $(date -u +%H:%M:%SZ)"
  g s3 cp "$OLD/$rel" "$local_file" --only-show-errors

  got=$(wc -c < "$local_file" | tr -d ' ')
  if [ "$got" != "$size" ]; then
    echo "FAIL: downloaded $got bytes, expected $size" >&2
    exit 1
  fi

  echo "up   $(date -u +%H:%M:%SZ)"
  g s3 cp "$local_file" "$NEW/$rel" --only-show-errors

  rm -f "$local_file"
  echo "done $(date -u +%H:%M:%SZ)"
  echo
done < "$WORK/over.tsv"

rmdir "$BIG" 2>/dev/null || true
echo "Now run: bash migration/sync_data.sh --verify"
