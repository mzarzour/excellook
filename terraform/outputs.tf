# -------------------------------------------------------
# Outputs
# -------------------------------------------------------

output "cloudfront_url" {
  description = "CloudFront distribution domain — use this as a CNAME target in DNS"
  value       = "https://${aws_cloudfront_distribution.excellook.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID — needed for cache invalidation on deploy"
  value       = aws_cloudfront_distribution.excellook.id
}

output "s3_bucket_name" {
  description = "S3 bucket name — sync your Vite build output here to deploy"
  value       = aws_s3_bucket.excellook.bucket
}

output "acm_validation_records" {
  description = "Add these DNS CNAME records to Cloudflare to validate the ACM certificate before deploying"
  value = {
    for dvo in aws_acm_certificate.excellook.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }
}

output "deploy_access_key_id" {
  description = "AWS access key ID for the CI/CD deploy user — store in GitHub Actions secrets as AWS_ACCESS_KEY_ID"
  value       = aws_iam_access_key.deploy.id
}

output "deploy_secret_access_key" {
  description = "AWS secret access key for the CI/CD deploy user — store in GitHub Actions secrets as AWS_SECRET_ACCESS_KEY"
  value       = aws_iam_access_key.deploy.secret
  sensitive   = true
}
