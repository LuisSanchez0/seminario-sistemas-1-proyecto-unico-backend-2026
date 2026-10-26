terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    vercel = { source = "vercel/vercel", version = "~> 5.21.1" }
  }
  backend "s3" {}
}
provider "aws" {
  region = var.aws_region
  default_tags { tags = merge(var.tags, { Project = "LuminaBeauty", Environment = var.environment }) }
}
# Token comes only from the VERCEL_API_TOKEN environment variable (Jenkins secret / operator shell).
provider "vercel" {
  team = var.vercel_team
}
