#!/usr/bin/env bash
set -euo pipefail
: "${GIT_COMMIT:?Full Git SHA required}"
[[ "$GIT_COMMIT" =~ ^[a-f0-9]{40}$ ]]
mkdir -p artifacts
# JavaScript has no compile step: validate syntax, then package the production image.
find config controllers database helpers middlewares models routes -name '*.js' -print0 | xargs -0 -n1 node --check
node --check app.js
docker build --platform linux/amd64 --target production --label "org.opencontainers.image.revision=$GIT_COMMIT" -t "lumina-api:$GIT_COMMIT" .
docker run --rm --entrypoint node "lumina-api:$GIT_COMMIT" --check app.js
docker image inspect "lumina-api:$GIT_COMMIT" --format '{{.Config.User}}' | grep -qx node
docker save "lumina-api:$GIT_COMMIT" | gzip > artifacts/api.tar.gz
sha256sum artifacts/api.tar.gz > artifacts/api.tar.gz.sha256
test -s artifacts/api.tar.gz
