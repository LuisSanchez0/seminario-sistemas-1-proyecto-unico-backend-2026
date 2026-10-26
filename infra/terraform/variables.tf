variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "environment" {
  type    = string
  default = "staging"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "Use a short lowercase environment name."
  }
}
variable "vpc_id" {
  type = string
}
variable "subnet_id" {
  type        = string
  description = "Existing public subnet with an internet gateway route; no network is created."
}
variable "instance_type" {
  type    = string
  default = "t3.small"
}
variable "ami_id" {
  type        = string
  default     = null
  description = "Optional pinned Amazon Linux 2023 x86_64 AMI; otherwise resolve the AWS public SSM parameter."
}
variable "backend_port" {
  type        = number
  default     = 8080
  description = "Application port, bound to 127.0.0.1 only and reached through the on-instance reverse proxy."
  validation {
    condition     = var.backend_port >= 1024 && var.backend_port <= 65535
    error_message = "Use an unprivileged container port."
  }
}
variable "backend_exposure_mode" {
  type        = string
  default     = "quick_tunnel"
  description = <<-EOT
    quick_tunnel: TEMPORARY demo. cloudflared Quick Tunnel, random https://*.trycloudflare.com URL that changes whenever
    the tunnel restarts; no domain, DNS, Elastic IP or inbound rules. NOT a stable production hostname.
    direct_https: stable. Caddy with a Let's Encrypt certificate for backend_domain on an Elastic IP (inbound 80/443).
  EOT
  validation {
    condition     = contains(["quick_tunnel", "direct_https"], var.backend_exposure_mode)
    error_message = "Use quick_tunnel or direct_https."
  }
}
variable "public_ingress_cidrs" {
  type        = set(string)
  default     = ["0.0.0.0/0"]
  description = "direct_https only: clients allowed to reach Caddy on 443 (and 80 for ACME/redirect). The application port is never opened."
  validation {
    condition     = alltrue([for cidr in var.public_ingress_cidrs : can(cidrnetmask(cidr))])
    error_message = "Use IPv4 CIDR blocks."
  }
}
variable "backend_domain" {
  type        = string
  default     = null
  description = "direct_https only: public API hostname (e.g. api.example.com) whose A record points to the backend Elastic IP."
  validation {
    condition     = var.backend_domain == null ? var.backend_exposure_mode != "direct_https" : can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$", var.backend_domain))
    error_message = "direct_https requires backend_domain as a lowercase DNS hostname without scheme, port, path or IP address."
  }
}
variable "cloudflared_version" {
  type        = string
  default     = "2026.10.0"
  description = "quick_tunnel only: pinned official cloudflared release (update together with cloudflared_sha256)."
  validation {
    condition     = can(regex("^[0-9]{4}[.][0-9]{1,2}[.][0-9]+$", var.cloudflared_version))
    error_message = "Use an exact cloudflared release version."
  }
}
variable "cloudflared_sha256" {
  type        = string
  default     = "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db"
  description = "SHA-256 of cloudflared-linux-amd64 for cloudflared_version, as published in the release notes."
  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.cloudflared_sha256))
    error_message = "Use the 64-character SHA-256 checksum."
  }
}
variable "tunnel_egress_cidr" {
  type        = string
  default     = "0.0.0.0/0"
  description = "quick_tunnel only: destination for outbound Cloudflare Tunnel traffic on 7844 (Cloudflare documents its edge IPs as subject to change)."
  validation {
    condition     = can(cidrnetmask(var.tunnel_egress_cidr))
    error_message = "Use an IPv4 CIDR block."
  }
}
variable "caddy_version" {
  type        = string
  default     = "2.11.7"
  description = "direct_https only: pinned official Caddy release (AL2023 has no Caddy package)."
  validation {
    condition     = can(regex("^[0-9]+[.][0-9]+[.][0-9]+$", var.caddy_version))
    error_message = "Use an exact Caddy release version."
  }
}
variable "caddy_sha512" {
  type        = string
  default     = "a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7"
  description = "SHA-512 of caddy_<version>_linux_amd64.tar.gz from the release checksums file; update together with caddy_version."
  validation {
    condition     = can(regex("^[a-f0-9]{128}$", var.caddy_sha512))
    error_message = "Use the 128-character SHA-512 checksum."
  }
}
variable "dependency_egress" {
  type        = map(object({ cidr = string, port = number }))
  default     = {}
  description = "Existing MongoDB/Redis destinations. Never provision new databases here."
}
variable "frontend_bucket_name" {
  type        = string
  description = "Legacy S3 website bucket. Retained (versioned, encrypted) after the Vercel migration until manually decommissioned."
}
variable "legacy_frontend_website" {
  type        = bool
  default     = true
  description = "Keep the old public S3 website (HTTP) while Vercel is verified. Set false to remove website hosting and public read; the bucket itself is kept."
}
variable "vercel_team" {
  type        = string
  default     = null
  description = "Vercel team slug or ID; null uses the token's personal account."
}
variable "vercel_project_name" {
  type        = string
  default     = null
  description = "Vercel project name; defaults to lumina-<environment>-frontend."
  validation {
    condition     = var.vercel_project_name == null || can(regex("^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$", var.vercel_project_name))
    error_message = "Use lowercase letters, digits and hyphens."
  }
}
variable "vercel_production_domain" {
  type        = string
  default     = null
  description = "Generated Vercel production hostname if it differs from <project>.vercel.app (Vercel adds a suffix when the name is taken)."
  validation {
    condition     = var.vercel_production_domain == null || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?[.]vercel[.]app$", var.vercel_production_domain))
    error_message = "Use the project's *.vercel.app production hostname."
  }
}
variable "frontend_domain" {
  type        = string
  default     = null
  description = "Optional custom frontend hostname attached to the Vercel project. DNS stays with its current provider."
  validation {
    condition     = var.frontend_domain == null || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$", var.frontend_domain))
    error_message = "Use a lowercase DNS hostname without scheme, port or path."
  }
}
variable "artifact_bucket_name" {
  type = string
}
variable "media_bucket_name" {
  type        = string
  description = "Existing product/receipt bucket, not managed by this stack."
}
variable "media_prefixes" {
  type    = set(string)
  default = ["uploads/images/"]
}
variable "app_env_parameter_name" {
  type        = string
  description = "Existing SSM SecureString containing dotenv configuration. Values are never read by Terraform."
  validation {
    condition     = can(regex("^/[a-zA-Z0-9_./-]+$", var.app_env_parameter_name))
    error_message = "Use an absolute SSM parameter path."
  }
}
variable "app_env_kms_key_arn" {
  type        = string
  default     = null
  description = "Customer KMS key ARN if the environment SecureString uses one."
}
variable "tags" {
  type    = map(string)
  default = {}
}
