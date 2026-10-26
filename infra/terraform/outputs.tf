output "instance_id" { value = aws_instance.backend.id }
output "backend_exposure_mode" { value = var.backend_exposure_mode }
output "backend_port" { value = var.backend_port }
# quick_tunnel: the public API URL is TEMPORARY and discovered at deploy time; read the current verified value from
# this SSM parameter (written by ci/deploy.py) or the backend job's artifacts/public-api-url.txt.
output "public_api_url_parameter" { value = local.public_api_url_parameter }
output "tunnel_document" { value = one(aws_ssm_document.tunnel[*].name) }
# direct_https only (null in quick_tunnel mode).
output "backend_elastic_ip" { value = one(aws_eip.backend[*].public_ip) }
output "backend_domain" { value = var.backend_domain }
output "backend_https_url" { value = local.direct_https ? "https://${var.backend_domain}" : null }
output "backend_api_url" { value = local.backend_api_url }
output "backend_dns_record" {
  description = "direct_https only: create this record at the current DNS provider before the first HTTPS deployment."
  value       = local.direct_https ? "${var.backend_domain}. A ${aws_eip.backend[0].public_ip}" : null
}
output "vercel_project_id" { value = vercel_project.frontend.id }
output "vercel_team_id" { value = vercel_project.frontend.team_id }
output "vercel_production_url" { value = "https://${local.vercel_production_domain}" }
output "frontend_domain" { value = var.frontend_domain }
output "frontend_url" { value = local.frontend_url }
output "frontend_origins" { value = local.frontend_origins }
output "legacy_frontend_bucket" { value = aws_s3_bucket.frontend.id }
output "legacy_frontend_website_url" {
  value = var.legacy_frontend_website ? "http://${aws_s3_bucket_website_configuration.frontend[0].website_endpoint}" : null
}
output "artifact_bucket" { value = aws_s3_bucket.artifacts.id }
output "deploy_document" { value = aws_ssm_document.deploy.name }
output "log_group" { value = aws_cloudwatch_log_group.backend.name }
