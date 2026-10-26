data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_subnet" "existing" { id = var.subnet_id }
data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}
locals {
  name          = "lumina-${var.environment}"
  parameter_arn = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.app_env_parameter_name}"
  # quick_tunnel: TEMPORARY demo exposure (outbound-only cloudflared, random *.trycloudflare.com URL, no inbound rules).
  # direct_https: stable exposure (Caddy TLS on an Elastic IP for an owned backend_domain).
  quick_tunnel = var.backend_exposure_mode == "quick_tunnel"
  direct_https = var.backend_exposure_mode == "direct_https"
  # Non-secret record of the currently verified public API URL, written by ci/deploy.py (not by Terraform).
  public_api_url_parameter     = "/lumina/${var.environment}/public-api-url"
  public_api_url_parameter_arn = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.public_api_url_parameter}"
}
# Description is immutable in EC2 (changing it replaces the group). Inbound exists only in direct_https mode.
resource "aws_security_group" "backend" {
  name_prefix = "${local.name}-"
  description = "HTTP only; administration exclusively through SSM"
  vpc_id      = var.vpc_id
}
# direct_https only: port 80 for Caddy's HTTP->HTTPS redirect and ACME HTTP-01. Never SSH or the application port.
resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each          = local.direct_https ? var.public_ingress_cidrs : toset([])
  security_group_id = aws_security_group.backend.id
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "Caddy redirect to HTTPS and ACME challenge"
}
resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each          = local.direct_https ? var.public_ingress_cidrs : toset([])
  security_group_id = aws_security_group.backend.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Public API over TLS terminated by Caddy"
}
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.backend.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "AWS APIs, package installation, Gmail SMTP TLS and Google auth"
}
resource "aws_vpc_security_group_egress_rule" "smtp" {
  security_group_id = aws_security_group.backend.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 465
  to_port           = 465
  ip_protocol       = "tcp"
  description       = "Existing Gmail Nodemailer transport (TLS)"
}
# quick_tunnel only: cloudflared dials the Cloudflare edge on 7844 (QUIC/UDP, falling back to HTTP/2 over TCP).
# Tunnel registration (api.trycloudflare.com) and the binary download use the 443 rule above.
resource "aws_vpc_security_group_egress_rule" "tunnel" {
  for_each          = local.quick_tunnel ? toset(["tcp", "udp"]) : toset([])
  security_group_id = aws_security_group.backend.id
  cidr_ipv4         = var.tunnel_egress_cidr
  from_port         = 7844
  to_port           = 7844
  ip_protocol       = each.value
  description       = "Outbound Cloudflare Tunnel (cloudflared)"
}
resource "aws_vpc_security_group_egress_rule" "dependencies" {
  for_each          = var.dependency_egress
  security_group_id = aws_security_group.backend.id
  cidr_ipv4         = each.value.cidr
  from_port         = each.value.port
  to_port           = each.value.port
  ip_protocol       = "tcp"
}
resource "aws_cloudwatch_log_group" "backend" {
  name              = "/lumina/${var.environment}/backend"
  retention_in_days = 30
}
resource "aws_iam_role" "backend" {
  name               = "${local.name}-ec2"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.backend.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "application" {
  role = aws_iam_role.backend.id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = local.parameter_arn },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.artifacts.arn}/releases/*" },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = [for prefix in var.media_prefixes : "arn:${data.aws_partition.current.partition}:s3:::${var.media_bucket_name}/${prefix}*"] },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.backend.arn}:*" }
    ], var.app_env_kms_key_arn == null ? [] : [
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.app_env_kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com" } } }
  ]) })
}
resource "aws_iam_instance_profile" "backend" { role = aws_iam_role.backend.name }
resource "aws_instance" "backend" {
  ami                         = coalesce(var.ami_id, data.aws_ssm_parameter.ami.value)
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.backend.id]
  iam_instance_profile        = aws_iam_instance_profile.backend.name
  user_data                   = file("${path.module}/bootstrap.sh")
  user_data_replace_on_change = true
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }
  root_block_device {
    encrypted   = true
    volume_size = 20
    volume_type = "gp3"
  }
  tags = { Name = "${local.name}-backend" }
  lifecycle {
    precondition {
      condition     = data.aws_subnet.existing.vpc_id == var.vpc_id
      error_message = "The subnet must belong to the specified existing VPC."
    }
  }
  depends_on = [aws_iam_role_policy_attachment.ssm, aws_iam_role_policy.application]
}
# direct_https only: DNS points straight at the instance, so its public address must survive stop/start.
# A Quick Tunnel needs no stable address (cloudflared connects outbound).
moved {
  from = aws_eip.backend
  to   = aws_eip.backend[0]
}
moved {
  from = aws_eip_association.backend
  to   = aws_eip_association.backend[0]
}
resource "aws_eip" "backend" {
  count  = local.direct_https ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${local.name}-backend" }
  lifecycle { prevent_destroy = true }
}
resource "aws_eip_association" "backend" {
  count         = local.direct_https ? 1 : 0
  instance_id   = aws_instance.backend.id
  allocation_id = aws_eip.backend[0].id
}
locals {
  # Only the selected exposure is rendered; Caddy templates need backend_domain, the tunnel needs none.
  caddy_setup = local.direct_https ? templatefile("${path.module}/proxy.sh.tftpl", {
    caddyfile     = templatefile("${path.module}/Caddyfile.tftpl", { domain = var.backend_domain, port = var.backend_port })
    caddy_service = file("${path.module}/caddy.service")
    caddy_version = var.caddy_version
    caddy_sha512  = var.caddy_sha512
    domain        = var.backend_domain
  }) : ""
  tunnel_setup = { for action, version in { deploy = "{{ Version }}", command = "" } : action => templatefile("${path.module}/tunnel.sh.tftpl", {
    action              = action == "deploy" ? "ensure" : "{{ Action }}"
    expected_version    = version
    port                = var.backend_port
    cloudflared_version = var.cloudflared_version
    cloudflared_sha256  = var.cloudflared_sha256
    tunnel_service      = templatefile("${path.module}/quick-tunnel.service.tftpl", { port = var.backend_port })
  }) }
}
resource "aws_ssm_document" "deploy" {
  name          = "${local.name}-deploy"
  document_type = "Command"
  content = jsonencode({ schemaVersion = "2.2", description = "Deploy a checksummed Lumina image on loopback, expose it (${var.backend_exposure_mode}) and verify health/revision", parameters = {
    ArtifactKey = { type = "String", allowedPattern = "^releases/[a-f0-9]{40}/api[.]tar[.]gz$" },
    Checksum    = { type = "String", allowedPattern = "^[a-f0-9]{64}$" },
    Version     = { type = "String", allowedPattern = "^[a-f0-9]{40}$" }
    }, mainSteps = [{ action = "aws:runShellScript", name = "deploy", inputs = { timeoutSeconds = "600", runCommand = [templatefile("${path.module}/deploy.sh.tftpl", {
      bucket       = aws_s3_bucket.artifacts.id, parameter = var.app_env_parameter_name, port = var.backend_port,
      region       = var.aws_region, log_group = aws_cloudwatch_log_group.backend.name,
      cors_origins = join(",", local.frontend_origins),
      trust_proxy  = local.quick_tunnel ? "cloudflared" : "loopback",
      exposure     = local.quick_tunnel ? local.tunnel_setup["deploy"] : local.caddy_setup
  })] } }] })
}
# quick_tunnel only: report (status) or deliberately rotate (restart cloudflared) the TEMPORARY public URL
# without redeploying the application. Prints the verified URL as LUMINA_PUBLIC_API_URL=...
resource "aws_ssm_document" "tunnel" {
  count         = local.quick_tunnel ? 1 : 0
  name          = "${local.name}-tunnel"
  document_type = "Command"
  content = jsonencode({ schemaVersion = "2.2", description = "Report or rotate the TEMPORARY Cloudflare Quick Tunnel URL and verify health through it", parameters = {
    Action = { type = "String", allowedValues = ["status", "rotate"] }
    }, mainSteps = [{ action = "aws:runShellScript", name = "tunnel", inputs = { timeoutSeconds = "300", runCommand = [templatefile("${path.module}/tunnel-command.sh.tftpl", {
      tunnel_setup = local.tunnel_setup["command"], port = var.backend_port
  })] } }] })
}
