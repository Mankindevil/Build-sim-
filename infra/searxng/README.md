# Local SearXNG for official catalog discovery

This service is optional and only listens on `127.0.0.1:8080`. Its JSON API is
enabled for the provider in `scripts/price-server/catalog/searxng-discovery.mjs`.
The container image is pinned by digest and the secret is generated at runtime;
no secret is stored in this repository.

```sh
node scripts/searxng-local.mjs up
CATALOG_DISCOVERY_PROVIDER=searxng SEARXNG_BASE_URL=http://127.0.0.1:8080 npm run price:serve
npm run searxng:smoke
```

Use `health` to verify the JSON endpoint, `status` to inspect the container, and
`stop` to stop it without deleting data. This local service discovers candidate
URLs only. The catalog pipeline still fetches and validates official pages before
it can produce official field evidence.

Scanned-PDF OCR is a separate, opt-in server feature:

```sh
CATALOG_PDF_OCR_ENABLED=1 CATALOG_PDF_OCR_MAX_PAGES=3 npm run price:serve
```

OCR uses pinned local English language data, bounded page rendering, pixel and
timeout limits. OCR-derived fields are marked `official-ocr-pdf` and stay
`partial` for manual review; they cannot pass the direct auto-accept gate.
