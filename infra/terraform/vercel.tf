# Frontend: Angular on Vercel over HTTPS at the stable https://<project>.vercel.app (no custom domain required).
# Terraform owns the stable project settings; Jenkins (frontend Jenkinsfile) is the only deployer: it uploads the
# already-tested Angular build with `vercel deploy --prebuilt --prod`. No git_repository is connected.
# PUBLIC_API_URL is deliberately NOT a Terraform-managed Vercel variable: in quick_tunnel mode it changes with every
# tunnel restart. Its single source is the backend deployment (ci/deploy.py publishes the verified URL to SSM
# Parameter Store and passes it to the frontend job), which compiles it into the build.
locals {
  vercel_project_name      = coalesce(var.vercel_project_name, "lumina-${var.environment}-frontend")
  vercel_production_domain = coalesce(var.vercel_production_domain, "${local.vercel_project_name}.vercel.app")
  frontend_url             = "https://${coalesce(var.frontend_domain, local.vercel_production_domain)}"
  # Exact browser origins allowed by backend CORS.
  frontend_origins = distinct(concat(["https://${local.vercel_production_domain}"], var.frontend_domain == null ? [] : ["https://${var.frontend_domain}"]))
  # Stable only in direct_https; the quick-tunnel URL is discovered at deploy time.
  backend_api_url = local.direct_https ? "https://${var.backend_domain}/api" : null
}
resource "vercel_project" "frontend" {
  name      = local.vercel_project_name
  framework = "angular"
  # Mirror the Jenkins build so a manual Vercel build would behave identically.
  install_command  = "npm ci"
  build_command    = "npm run build -- --configuration production"
  output_directory = "dist/luminabeauty-app/browser"
  node_version     = "22.x"
  # Preview and generated deployment URLs require Vercel login; production domains are public.
  vercel_authentication = { deployment_type = "standard_protection_new" }
}
resource "vercel_project_domain" "frontend" {
  count      = var.frontend_domain == null ? 0 : 1
  project_id = vercel_project.frontend.id
  domain     = var.frontend_domain
}
