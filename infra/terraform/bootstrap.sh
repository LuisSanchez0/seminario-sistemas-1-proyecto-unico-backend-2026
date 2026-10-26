#!/bin/bash
set -euo pipefail
dnf install -y docker awscli-2 python3
systemctl enable --now docker amazon-ssm-agent
install -d -m 700 /opt/lumina
# No secrets in user_data. Jenkins deploys via the constrained SSM document.
