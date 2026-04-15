# Deployment Guide

## First-time setup

### 1. Apply just the ACM certificate first

```bash
cd terraform
terraform init
terraform apply -target=aws_acm_certificate.excellook
```

### 2. Add DNS validation records to Cloudflare

```bash
terraform output acm_validation_records
```

Add the CNAME record(s) it prints to your Cloudflare DNS panel.  
Wait for the certificate status to become `ISSUED` (usually 2–5 minutes):

```bash
aws acm describe-certificate \
  --certificate-arn <arn from output> \
  --region us-east-1 \
  --query 'Certificate.Status'
```

### 3. Apply the rest of the infrastructure

```bash
terraform apply
```

### 4. Point your domain at CloudFront

In Cloudflare, create a CNAME record:

| Name | Target | Proxy |
|------|--------|-------|
| `w` | `<cloudfront_url output>` | DNS only (grey cloud) |

> Set to **DNS only** (not proxied) — CloudFront handles CDN and HTTPS.

### 5. Store deploy credentials in GitHub Actions secrets

```bash
terraform output deploy_access_key_id
terraform output -raw deploy_secret_access_key
```

Add to your GitHub repository secrets:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `CLOUDFRONT_DISTRIBUTION_ID` (from `terraform output cloudfront_distribution_id`)
- `S3_BUCKET` (from `terraform output s3_bucket_name`)

---

## Deploying a new build

```bash
# Build
npm run build

# Sync to S3 (hashed assets: 1-year cache, index.html: no cache)
aws s3 sync dist/ s3://<bucket> \
  --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp dist/index.html s3://<bucket>/index.html \
  --cache-control "no-cache, no-store, must-revalidate"

# Invalidate CloudFront cache for index.html
aws cloudfront create-invalidation \
  --distribution-id <distribution-id> \
  --paths "/index.html"
```

Or use the GitHub Actions workflow (`.github/workflows/deploy.yml`) which runs this automatically on push to `main`.

---

## Teardown

```bash
# Empty the bucket first (Terraform cannot delete a non-empty bucket)
aws s3 rm s3://<bucket> --recursive
terraform destroy
```
