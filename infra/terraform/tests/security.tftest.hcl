mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:root" }
  }

  mock_data "aws_subnet" {
    defaults = { vpc_id = "vpc-0123456789abcdef0" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
}
mock_provider "vercel" {}
# Known at plan time so the rendered SSM deployment script can be asserted.
override_resource {
  target          = aws_s3_bucket.artifacts
  override_during = plan
  values          = { id = "qa-lumina-artifacts", arn = "arn:aws:s3:::qa-lumina-artifacts" }
}
variables {
  vpc_id                 = "vpc-0123456789abcdef0"
  subnet_id              = "subnet-0123456789abcdef0"
  frontend_bucket_name   = "qa-lumina-frontend"
  artifact_bucket_name   = "qa-lumina-artifacts"
  media_bucket_name      = "qa-existing-media"
  app_env_parameter_name = "/lumina/qa/app-env"
}
run "quick_tunnel_defaults" {
  command = plan
  assert {
    condition     = var.backend_exposure_mode == "quick_tunnel" && var.backend_domain == null
    error_message = "The default is the temporary no-domain Quick Tunnel."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.http) == 0 && length(aws_vpc_security_group_ingress_rule.https) == 0
    error_message = "Quick Tunnel mode needs no inbound rule at all (no 80/443/8080/SSH)."
  }
  assert {
    condition     = toset([for rule in values(aws_vpc_security_group_egress_rule.tunnel) : "${rule.ip_protocol}/${rule.from_port}-${rule.to_port}"]) == toset(["tcp/7844-7844", "udp/7844-7844"])
    error_message = "cloudflared needs outbound 7844 TCP/UDP to the Cloudflare edge."
  }
  assert {
    condition     = length(aws_eip.backend) == 0 && length(aws_eip_association.backend) == 0
    error_message = "No Elastic IP is required for an outbound tunnel."
  }
  assert {
    condition     = aws_instance.backend.metadata_options[0].http_tokens == "required" && aws_instance.backend.root_block_device[0].encrypted
    error_message = "EC2 hardening (IMDSv2, encrypted disk) is preserved."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.artifacts.block_public_policy && aws_s3_bucket_public_access_block.artifacts.restrict_public_buckets
    error_message = "Artifacts must remain private."
  }
  assert {
    condition     = length(aws_s3_bucket_website_configuration.frontend) == 1 && aws_s3_bucket_website_configuration.frontend[0].error_document[0].key == "index.html"
    error_message = "By default the legacy website is left unchanged until Vercel is verified."
  }
  assert {
    condition = alltrue([
      strcontains(aws_ssm_document.deploy.content, "--network host"),
      strcontains(aws_ssm_document.deploy.content, "-e HOST=127.0.0.1"),
      strcontains(aws_ssm_document.deploy.content, "-e TRUST_PROXY=cloudflared"),
      strcontains(aws_ssm_document.deploy.content, "http://127.0.0.1:8080/api/health"),
      !strcontains(aws_ssm_document.deploy.content, "-p 80:"),
    ])
    error_message = "The API binds to loopback and trusts only the local cloudflared hop."
  }
  assert {
    condition = alltrue([
      strcontains(aws_ssm_document.deploy.content, "--url http://127.0.0.1:8080"),
      strcontains(aws_ssm_document.deploy.content, "--metrics 127.0.0.1:20241"),
      strcontains(aws_ssm_document.deploy.content, "--no-autoupdate"),
      strcontains(aws_ssm_document.deploy.content, "releases/download/2026.10.0/cloudflared-linux-amd64"),
      strcontains(aws_ssm_document.deploy.content, "sha256sum -c -"),
      strcontains(aws_ssm_document.deploy.content, "/quicktunnel"),
      strcontains(aws_ssm_document.deploy.content, "trycloudflare[.]com"),
      strcontains(aws_ssm_document.deploy.content, "LUMINA_PUBLIC_API_URL="),
      strcontains(aws_ssm_document.deploy.content, "tunnel_action='ensure'"),
      !strcontains(aws_ssm_document.deploy.content, "reverse_proxy"),
      !strcontains(aws_ssm_document.deploy.content, "--insecure"),
      !strcontains(aws_ssm_document.deploy.content, "curl -k"),
      !strcontains(aws_ssm_document.deploy.content, "--no-tls-verify"),
      !strcontains(aws_ssm_document.deploy.content, "TUNNEL_TOKEN"),
    ])
    error_message = "Pinned, verified cloudflared quick tunnel to loopback with machine-readable URL discovery and no credentials."
  }
  assert {
    condition = (
      length(aws_ssm_document.tunnel) == 1 &&
      strcontains(aws_ssm_document.tunnel[0].content, "\"allowedValues\":[\"status\",\"rotate\"]") &&
      strcontains(aws_ssm_document.tunnel[0].content, "tunnel_action='{{ Action }}'")
    )
    error_message = "A constrained document reports or rotates the tunnel URL without redeploying."
  }
  assert {
    condition     = strcontains(aws_ssm_document.deploy.content, "CORS_ORIGINS='https://lumina-staging-frontend.vercel.app'")
    error_message = "CORS must allow exactly the Vercel production origin (the tunnel URL is the API, not a browser origin)."
  }
  assert {
    condition     = vercel_project.frontend.framework == "angular" && vercel_project.frontend.git_repository == null && vercel_project.frontend.output_directory == "dist/luminabeauty-app/browser"
    error_message = "Vercel project must be Angular with no Git auto-deploy competing with Jenkins."
  }
  assert {
    condition     = length(vercel_project_domain.frontend) == 0 && output.frontend_url == "https://lumina-staging-frontend.vercel.app" && output.backend_api_url == null && output.public_api_url_parameter == "/lumina/staging/public-api-url"
    error_message = "No custom domain; the API URL comes from the deployment-published parameter, not a stale Terraform value."
  }
}
run "direct_https_mode" {
  command = plan
  variables {
    backend_exposure_mode = "direct_https"
    backend_domain        = "api.example.com"
  }
  assert {
    condition = (
      [for rule in values(aws_vpc_security_group_ingress_rule.http) : [rule.from_port, rule.to_port, rule.cidr_ipv4]] == [[80, 80, "0.0.0.0/0"]] &&
      [for rule in values(aws_vpc_security_group_ingress_rule.https) : [rule.from_port, rule.to_port, rule.cidr_ipv4]] == [[443, 443, "0.0.0.0/0"]] &&
      length(aws_vpc_security_group_egress_rule.tunnel) == 0
    )
    error_message = "Direct HTTPS: exactly 80 (redirect/ACME) and 443 (TLS); no tunnel egress."
  }
  assert {
    condition     = length(aws_eip.backend) == 1 && aws_eip.backend[0].domain == "vpc" && length(aws_ssm_document.tunnel) == 0
    error_message = "Direct HTTPS keeps the stable Elastic IP and has no tunnel document."
  }
  assert {
    condition = alltrue([
      strcontains(aws_ssm_document.deploy.content, "-e TRUST_PROXY=loopback"),
      strcontains(aws_ssm_document.deploy.content, "reverse_proxy 127.0.0.1:8080"),
      strcontains(aws_ssm_document.deploy.content, "api.example.com {"),
      strcontains(aws_ssm_document.deploy.content, "admin unix//run/caddy/admin.sock"),
      strcontains(aws_ssm_document.deploy.content, "--resolve 'api.example.com:443:127.0.0.1' 'https://api.example.com/api/health'"),
      strcontains(aws_ssm_document.deploy.content, "sha512sum -c -"),
      !strcontains(aws_ssm_document.deploy.content, "lumina-quick-tunnel.service.next"),
      !strcontains(aws_ssm_document.deploy.content, "tls internal"),
    ])
    error_message = "Caddy proxies the domain to loopback with a verified binary and a trusted certificate check."
  }
  assert {
    condition     = output.backend_api_url == "https://api.example.com/api" && output.backend_https_url == "https://api.example.com"
    error_message = "Direct HTTPS publishes the stable API URL."
  }
}
run "legacy_website_decommissioned" {
  command = plan
  variables {
    legacy_frontend_website = false
  }
  assert {
    condition     = length(aws_s3_bucket_website_configuration.frontend) == 0 && length(aws_s3_bucket_policy.frontend) == 0 && length(aws_iam_policy.jenkins_frontend) == 0
    error_message = "Decommissioning removes website hosting, public read and the S3 publisher policy."
  }
  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.frontend.block_public_acls, aws_s3_bucket_public_access_block.frontend.block_public_policy,
      aws_s3_bucket_public_access_block.frontend.ignore_public_acls, aws_s3_bucket_public_access_block.frontend.restrict_public_buckets,
    ])
    error_message = "The retained legacy bucket must become fully private."
  }
  assert {
    condition     = aws_s3_bucket.frontend.bucket == "qa-lumina-frontend" && aws_s3_bucket_versioning.buckets["frontend"].versioning_configuration[0].status == "Enabled" && output.legacy_frontend_website_url == null
    error_message = "The bucket and its versions are kept for manual decommissioning."
  }
}
run "custom_frontend_domain" {
  command = plan
  variables {
    vercel_project_name = "lumina-shop"
    frontend_domain     = "shop.example.com"
  }
  assert {
    condition     = length(vercel_project_domain.frontend) == 1 && vercel_project_domain.frontend[0].domain == "shop.example.com"
    error_message = "A supplied frontend domain is attached to the Vercel project."
  }
  assert {
    condition     = output.frontend_url == "https://shop.example.com" && output.frontend_origins == tolist(["https://lumina-shop.vercel.app", "https://shop.example.com"])
    error_message = "CORS origins must be exactly the Vercel production and custom domains."
  }
}
run "direct_https_requires_domain" {
  command = plan
  variables {
    backend_exposure_mode = "direct_https"
  }
  expect_failures = [var.backend_domain]
}
run "rejects_url_as_backend_domain" {
  command = plan
  variables {
    backend_exposure_mode = "direct_https"
    backend_domain        = "https://api.example.com"
  }
  expect_failures = [var.backend_domain]
}
run "rejects_ip_as_backend_domain" {
  command = plan
  variables {
    backend_exposure_mode = "direct_https"
    backend_domain        = "203.0.113.10"
  }
  expect_failures = [var.backend_domain]
}
run "rejects_unknown_exposure_mode" {
  command = plan
  variables {
    backend_exposure_mode = "public_port"
  }
  expect_failures = [var.backend_exposure_mode]
}
