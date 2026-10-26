#!/usr/bin/env bash
set -euo pipefail
# Usage: bash ci/deploy.sh [deploy|tunnel-status|tunnel-rotate]   (same script for Jenkins and the manual demo path)
action=${1:-deploy}
: "${AWS_REGION:?}"
[ "$action" != deploy ] || : "${GIT_COMMIT:?}"
# Infrastructure is applied separately. A nonzero plan (including drift) blocks deployment.
targets_file=$(mktemp)
trap 'rm -f "$targets_file"' EXIT
terraform -chdir=infra/terraform output -json > "$targets_file"
TARGETS_FILE="$targets_file" python3 ci/deploy.py "$action"
