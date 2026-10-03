#!/usr/bin/env bash
#
# Copy the published objects from the retired location to the current one.
#
#   old: s3://us-west-2.opendata.source.coop/portolan-mirrors/sentinel-2-catalog/
#   new: s3://us-west-2.opendata.source.coop/tge-labs/s2-stac-geoparquet/
#
# Both prefixes are in one bucket, so `aws s3 sync` issues server-side copies.
# No object travels to this machine and no egress is billed.
#
# This script defaults to a dry run. It copies nothing until you pass
# --confirm.
#
#   bash migration/sync_data.sh                 # plan only
#   bash migration/sync_data.sh --confirm       # copy
#   bash migration/sync_data.sh --verify        # compare the two prefixes
#
# Credentials. One identity must read the old prefix and write the new one.
# The per-organization roles cannot do both, because Source Cooperative scopes
# each to its own prefix. Use an identity with access to both, and set it with
# --profile. The script verifies that access before it copies anything.
#
set -euo pipefail

BUCKET="us-west-2.opendata.source.coop"
OLD="portolan-mirrors/sentinel-2-catalog"
NEW="tge-labs/s2-stac-geoparquet"
REGION="us-west-2"
PROFILE="${AWS_PROFILE:-radiant-source-admin}"

# Scratch prefixes the retired location accumulated. They are build artifacts
# and smoke-test leftovers, not catalog content, so the new location starts
# without them. `_assets/` is catalog content: catalog.json links its icon.
EXCLUDES=(
  "--exclude" "_work/*"
  "--exclude" "_smoke/*"
  "--exclude" "_experiments/*"
  "--exclude" "_access-check"
  "--exclude" "_access-check/*"
)

MODE="plan"
for arg in "$@"; do
  case "$arg" in
    --confirm) MODE="copy" ;;
    --verify)  MODE="verify" ;;
    --profile=*) PROFILE="${arg#*=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }

echo "profile : $PROFILE"
echo "old     : s3://$BUCKET/$OLD/"
echo "new     : s3://$BUCKET/$NEW/"
echo

# --- preflight: the identity must read the old prefix and write the new -----

echo "== preflight =="
aws sts get-caller-identity --query Arn --output text

if ! aws s3 ls "s3://$BUCKET/$OLD/" > /dev/null; then
  echo "FAIL: cannot list the old prefix with profile $PROFILE" >&2
  exit 1
fi
echo "read  old prefix: ok"

PROBE="s3://$BUCKET/$NEW/_migration-probe"
if ! date -u | aws s3 cp - "$PROBE" > /dev/null 2>&1; then
  echo "FAIL: cannot write the new prefix with profile $PROFILE" >&2
  echo "      The Source Cooperative product tge-labs/s2-stac-geoparquet" >&2
  echo "      must exist, and this identity must be able to write it." >&2
  exit 1
fi
aws s3 rm "$PROBE" > /dev/null
echo "write new prefix: ok"
echo

# --- what is there ----------------------------------------------------------

summarize() {  # summarize <prefix> <label>
  echo "== $2 =="
  aws s3 ls "s3://$BUCKET/$1/" --recursive --summarize \
    | tail -3
}

case "$MODE" in
  plan)
    summarize "$OLD" "source inventory"
    echo
    echo "== top-level keys at the source =="
    aws s3 ls "s3://$BUCKET/$OLD/"
    echo
    echo "== planned copy (dry run) =="
    aws s3 sync "s3://$BUCKET/$OLD/" "s3://$BUCKET/$NEW/" \
      "${EXCLUDES[@]}" --dryrun | head -40
    echo
    echo "(showing the first 40 operations)"
    echo "Re-run with --confirm to copy."
    ;;

  copy)
    echo "== copying =="
    # --copy-props none keeps the destination objects free of the source's
    # tags and metadata, which name the retired location in some objects.
    aws s3 sync "s3://$BUCKET/$OLD/" "s3://$BUCKET/$NEW/" \
      "${EXCLUDES[@]}" --copy-props none --only-show-errors
    echo "copy finished"
    echo
    echo "Next: re-run with --verify, then publish the metadata."
    echo "See migration/README.md step 4."
    ;;

  verify)
    echo "== verify =="
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    # Compare key, size for every object, with the prefix stripped so the
    # two listings line up. A sync that dropped or truncated an object shows
    # up as a diff line.
    aws s3 ls "s3://$BUCKET/$OLD/" --recursive \
      | awk '{print $3, $4}' | sed "s| $OLD/| |" | sort > "$tmp/old"
    aws s3 ls "s3://$BUCKET/$NEW/" --recursive \
      | awk '{print $3, $4}' | sed "s| $NEW/| |" | sort > "$tmp/new"

    # Drop the scratch prefixes from the old side: they were never copied.
    grep -vE ' (_work/|_smoke/|_experiments/|_access-check)' "$tmp/old" \
      > "$tmp/old.cmp" || true
    cp "$tmp/new" "$tmp/new.cmp"

    echo "objects expected: $(wc -l < "$tmp/old.cmp")"
    echo "objects present : $(wc -l < "$tmp/new.cmp")"
    echo

    if diff -u "$tmp/old.cmp" "$tmp/new.cmp" > "$tmp/diff"; then
      echo "PASS: every expected object is present at the same size."
    else
      echo "DIFF: the two prefixes do not match."
      echo "  '-' lines are missing from the new prefix."
      echo "  '+' lines are extra there."
      head -60 "$tmp/diff"
      exit 1
    fi
    ;;
esac
