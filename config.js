// Default config for hosting the dashboard as static files (e.g. an S3 website).
// dashboard/serve.py replaces this file at runtime with values from .local/.
//   apiUrl:     the read API base URL printed by scripts/deploy_backend.py (empty = demo data)
//   metricsUrl: CloudWatch endpoint; only serve.py provides one (empty = no metric charts)
// A URL query also works: index.html?api=https://ID.execute-api.REGION.amazonaws.com or ?demo
window.FRAUD_DASHBOARD_CONFIG = { apiUrl: "", metricsUrl: "" };
