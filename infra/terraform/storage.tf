resource "aws_s3_bucket" "frontend" { bucket = var.frontend_bucket_name }
resource "aws_s3_bucket" "artifacts" { bucket = var.artifact_bucket_name }
locals { buckets = { frontend = aws_s3_bucket.frontend.id, artifacts = aws_s3_bucket.artifacts.id } }
resource "aws_s3_bucket_ownership_controls" "buckets" {
  for_each = local.buckets
  bucket   = each.value
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "buckets" {
  for_each = local.buckets
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_versioning" "buckets" {
  for_each = local.buckets
  bucket   = each.value
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
# DEPRECATED: the production frontend is served by Vercel over HTTPS (vercel.tf).
# While legacy_frontend_website = true the old HTTP website is left exactly as it was (rollback window).
# Setting it false removes website hosting and public read; the private bucket and its versions are kept
# until they are deleted manually (docs/https-vercel-migration.md). Media/artifact/state buckets are unaffected.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = !var.legacy_frontend_website
  ignore_public_acls      = true
  restrict_public_buckets = !var.legacy_frontend_website
}
moved {
  from = aws_s3_bucket_website_configuration.frontend
  to   = aws_s3_bucket_website_configuration.frontend[0]
}
moved {
  from = aws_s3_bucket_policy.frontend
  to   = aws_s3_bucket_policy.frontend[0]
}
resource "aws_s3_bucket_website_configuration" "frontend" {
  count  = var.legacy_frontend_website ? 1 : 0
  bucket = aws_s3_bucket.frontend.id
  index_document { suffix = "index.html" }
  error_document { key = "index.html" }
}
resource "aws_s3_bucket_policy" "frontend" {
  count      = var.legacy_frontend_website ? 1 : 0
  bucket     = aws_s3_bucket.frontend.id
  policy     = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "${aws_s3_bucket.frontend.arn}/*" }] })
  depends_on = [aws_s3_bucket_public_access_block.frontend]
}
resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
