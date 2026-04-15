terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment to store state remotely (recommended for production):
  # backend "s3" {
  #   bucket = "your-terraform-state-bucket"
  #   key    = "excellook/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

# Default provider — used for S3 and CloudFront
provider "aws" {
  region = "us-east-1"
}

# ACM certificates for CloudFront MUST be in us-east-1
# This alias is used solely for the certificate resource
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# -------------------------------------------------------
# S3 Bucket — private origin for CloudFront
# -------------------------------------------------------

resource "aws_s3_bucket" "excellook" {
  bucket = replace(var.domain, ".", "-")  # e.g. w-evolvfishing-com

  tags = var.tags
}

resource "aws_s3_bucket_versioning" "excellook" {
  bucket = aws_s3_bucket.excellook.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Block all public access — CloudFront accesses via OAC only
resource "aws_s3_bucket_public_access_block" "excellook" {
  bucket = aws_s3_bucket.excellook.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Server-side encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "excellook" {
  bucket = aws_s3_bucket.excellook.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Bucket policy — allow CloudFront OAC to read objects
resource "aws_s3_bucket_policy" "excellook" {
  bucket = aws_s3_bucket.excellook.id

  # Must wait for public access block to be applied first
  depends_on = [aws_s3_bucket_public_access_block.excellook]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontOAC"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.excellook.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.excellook.arn
          }
        }
      }
    ]
  })
}

# -------------------------------------------------------
# ACM Certificate (DNS validation)
# -------------------------------------------------------

resource "aws_acm_certificate" "excellook" {
  provider          = aws.us_east_1
  domain_name       = var.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = var.tags
}

# NOTE: Add the DNS CNAME record(s) from the output below to your DNS provider
# (Cloudflare or Route 53) to complete certificate validation before applying
# the CloudFront distribution.
#
# Run: terraform apply -target=aws_acm_certificate.excellook
# Then: terraform output acm_validation_records
# Then add those CNAMEs to DNS, wait for validation, then: terraform apply

# -------------------------------------------------------
# CloudFront Origin Access Control
# -------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "excellook" {
  name                              = "${replace(var.domain, ".", "-")}-oac"
  description                       = "OAC for excellook S3 origin"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# -------------------------------------------------------
# CloudFront Response Headers Policy (security headers)
# -------------------------------------------------------

resource "aws_cloudfront_response_headers_policy" "excellook" {
  name    = "${replace(var.domain, ".", "-")}-security-headers"
  comment = "Security headers for excellook"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "same-origin"
      override        = true
    }

    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }

    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';"
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=()"
      override = true
    }
  }
}

# -------------------------------------------------------
# CloudFront Distribution
# -------------------------------------------------------

resource "aws_cloudfront_distribution" "excellook" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = var.price_class
  aliases             = [var.domain]
  comment             = "excellook — ${var.domain}"

  origin {
    domain_name              = aws_s3_bucket.excellook.bucket_regional_domain_name
    origin_id                = "s3-excellook"
    origin_access_control_id = aws_cloudfront_origin_access_control.excellook.id
  }

  # Redirect HTTP to HTTPS
  default_cache_behavior {
    target_origin_id       = "s3-excellook"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    response_headers_policy_id = aws_cloudfront_response_headers_policy.excellook.id

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    # Assets are content-hashed by Vite — cache aggressively
    min_ttl     = 0
    default_ttl = 86400    # 1 day
    max_ttl     = 31536000 # 1 year
  }

  # Cache hashed assets (JS/CSS) for 1 year
  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "s3-excellook"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    response_headers_policy_id = aws_cloudfront_response_headers_policy.excellook.id

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 31536000
    default_ttl = 31536000
    max_ttl     = 31536000
  }

  # SPA fallback — return index.html for all 403/404 (React Router support)
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.excellook.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = var.tags
}

# -------------------------------------------------------
# IAM — CI/CD deploy user (least-privilege S3 + CF invalidation)
# -------------------------------------------------------

resource "aws_iam_user" "deploy" {
  name = "excellook-deploy"
  tags = var.tags
}

resource "aws_iam_access_key" "deploy" {
  user = aws_iam_user.deploy.name
}

resource "aws_iam_user_policy" "deploy" {
  name = "excellook-deploy-policy"
  user = aws_iam_user.deploy.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3SyncBuild"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.excellook.arn,
          "${aws_s3_bucket.excellook.arn}/*"
        ]
      },
      {
        Sid    = "CloudFrontInvalidation"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation"
        ]
        Resource = aws_cloudfront_distribution.excellook.arn
      }
    ]
  })
}
