variable "domain" {
  description = "Primary domain for the excellook app (e.g. w.evolvfishing.com)"
  type        = string
  default     = "w.evolvfishing.com"
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 = US/EU only (cheapest). PriceClass_All = global."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "Must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default = {
    Project     = "excellook"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}
