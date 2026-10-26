#!/usr/bin/env bash
# TEMPORARY no-domain demo deployment without Jenkins. Runs the same gates, scripts and SSM documents as the two
# Jenkins jobs, in the same mandatory order: backend (tests, package, plan, SSM deploy, verified tunnel URL) and then
# frontend (tests, build compiled with that URL, prebuilt Vercel deploy, verification).
#
# Prerequisites (see docs/temporary-quick-tunnel-demo.md): infrastructure applied; `terraform -chdir=infra/terraform
# init -reconfigure -backend-config=<backend.hcl>` done; AWS credentials in the environment; VERCEL_API_TOKEN (Terraform
# plan) and VERCEL_TOKEN (Vercel CLI); TF_VARS=<real tfvars>; FRONTEND_DIR=<frontend repository>.
#
# Usage: bash ci/demo-deploy.sh [deploy|tunnel-status|tunnel-rotate]
#   deploy         release the current backend commit, then the frontend
#   tunnel-status  after an EC2 reboot / cloudflared restart: re-detect the current URL, then redeploy the frontend
#   tunnel-rotate  restart cloudflared (NEW URL), then redeploy the frontend
set -euo pipefail
action=${1:-deploy}
case "$action" in deploy | tunnel-status | tunnel-rotate) ;; *) echo "usage: $0 [deploy|tunnel-status|tunnel-rotate]" >&2; exit 2 ;; esac
: "${FRONTEND_DIR:?path to the frontend repository}" "${TF_VARS:?real terraform tfvars file}" \
  "${VERCEL_API_TOKEN:?Vercel token for the Terraform plan}" "${VERCEL_TOKEN:?Vercel token for the CLI deploy}"
export AWS_REGION=${AWS_REGION:-us-east-1}
backend=$(cd "$(dirname "$0")/.." && pwd)
frontend=$(cd "$FRONTEND_DIR" && pwd)
# Single source for the pinned CLI version: the frontend Jenkinsfile.
VERCEL_CLI_VERSION=$(sed -n "s/.*VERCEL_CLI_VERSION = '\([0-9.]*\)'.*/\1/p" "$frontend/Jenkinsfile")
export VERCEL_CLI_VERSION

echo "== 1/2 Backend: $action"
cd "$backend"
bash ci/check-runtime.sh
npm ci
npm test
terraform -chdir=infra/terraform plan -input=false -detailed-exitcode -var-file="$TF_VARS"
if [ "$action" = deploy ]; then
  GIT_COMMIT=$(git rev-parse HEAD)
  export GIT_COMMIT
  [ -z "$(git status --porcelain)" ] || echo "WARNING: uncommitted backend changes are packaged under revision $GIT_COMMIT" >&2
  bash ci/build.sh
fi
bash ci/deploy.sh "$action"

echo "== 2/2 Frontend with the verified API URL"
while IFS='=' read -r key value; do
  case "$key" in PUBLIC_API_URL | FRONTEND_URL | VERCEL_ORG_ID | VERCEL_PROJECT_ID) export "$key=$value" ;; esac
done < "$backend/artifacts/frontend.env"
cd "$frontend"
GIT_COMMIT=$(git rev-parse HEAD)
export GIT_COMMIT
[ -z "$(git status --porcelain)" ] || echo "WARNING: uncommitted frontend changes are deployed under revision $GIT_COMMIT" >&2
bash ci/check-runtime.sh
npm ci
npm test -- --watch=false
npm run build -- --configuration production
node ci/verify-artifact.mjs
bash ci/deploy.sh

echo "Frontend: $FRONTEND_URL"
echo "API:      $PUBLIC_API_URL"
echo "TEMPORARY demo: if cloudflared restarts or the instance reboots, the API URL changes; run: bash ci/demo-deploy.sh tunnel-status"
