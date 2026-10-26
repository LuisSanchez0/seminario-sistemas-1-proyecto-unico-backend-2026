# Attach these policies to the deployment identities configured in Jenkins.
# No access keys, Jenkins users, or infrastructure-administrator credentials are provisioned.
resource "aws_iam_policy" "jenkins_backend" {
  name = "${local.name}-jenkins-backend"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.artifacts.arn}/releases/*" },
    { Effect = "Allow", Action = ["ssm:SendCommand"], Resource = concat([aws_ssm_document.deploy.arn, aws_instance.backend.arn], aws_ssm_document.tunnel[*].arn) },
    { Effect = "Allow", Action = ["ssm:GetCommandInvocation"], Resource = "*" },
    # Publish/read the current verified public API URL (non-secret String parameter) and the live public IP for the closed-port check.
    { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:PutParameter"], Resource = local.public_api_url_parameter_arn },
    { Effect = "Allow", Action = ["ec2:DescribeInstances"], Resource = "*" }
  ] })
}
# Legacy S3 website publisher. The frontend pipeline now deploys to Vercel and needs no AWS access.
moved {
  from = aws_iam_policy.jenkins_frontend
  to   = aws_iam_policy.jenkins_frontend[0]
}
resource "aws_iam_policy" "jenkins_frontend" {
  count = var.legacy_frontend_website ? 1 : 0
  name  = "${local.name}-jenkins-frontend"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = aws_s3_bucket.frontend.arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.frontend.arn}/*" }
  ] })
}
# Plan identity needs read access to the managed resources, plus separate state-bucket access.
# Read-only describe/list APIs that do not support resource scoping require '*'.
resource "aws_iam_policy" "jenkins_plan" {
  name = "${local.name}-jenkins-plan"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ec2:DescribeInstances", "ec2:DescribeInstanceAttribute", "ec2:DescribeInstanceCreditSpecifications", "ec2:DescribeVolumes", "ec2:DescribeTags", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeAddresses", "ec2:DescribeAddressesAttribute", "logs:DescribeLogGroups"], Resource = "*" },
    { Effect = "Allow", Action = ["logs:ListTagsForResource"], Resource = aws_cloudwatch_log_group.backend.arn },
    { Effect = "Allow", Action = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"], Resource = aws_iam_role.backend.arn },
    { Effect = "Allow", Action = ["iam:GetInstanceProfile"], Resource = aws_iam_instance_profile.backend.arn },
    { Effect = "Allow", Action = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicyTags"], Resource = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${local.name}-jenkins-*" },
    { Effect = "Allow", Action = ["ssm:DescribeDocument", "ssm:GetDocument", "ssm:ListTagsForResource"], Resource = concat([aws_ssm_document.deploy.arn], aws_ssm_document.tunnel[*].arn) },
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}::parameter/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64" },
    { Effect = "Allow", Action = ["s3:GetBucketLocation", "s3:GetBucketTagging", "s3:GetBucketPolicy", "s3:GetBucketVersioning", "s3:GetBucketOwnershipControls", "s3:GetBucketPublicAccessBlock", "s3:GetEncryptionConfiguration", "s3:GetBucketWebsite", "s3:ListBucket"], Resource = [aws_s3_bucket.frontend.arn, aws_s3_bucket.artifacts.arn] }
  ] })
}
output "jenkins_backend_policy_arn" { value = aws_iam_policy.jenkins_backend.arn }
output "jenkins_frontend_policy_arn" { value = one(aws_iam_policy.jenkins_frontend[*].arn) }
output "jenkins_plan_policy_arn" { value = aws_iam_policy.jenkins_plan.arn }
