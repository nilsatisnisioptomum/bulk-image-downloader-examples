# Bulk image & file downloader — example inputs

Copy-paste JSON for [chris_elder/bulk-file-downloader](https://apify.com/chris_elder/bulk-file-downloader) on Apify.

**Landing page (process, pricing, FAQ):** https://tools.gptshopltd.com/bulk-image-downloader/

Built by [GPT Shop Ltd](https://tools.gptshopltd.com/) (UK 15766335).

## What it does

Downloads files from a URL list or an Apify dataset into the run storage, with optional ZIP. Image-only mode (`onlyImages`) skips non-images without charging. Optional `referer` / `userAgent` help with hotlink-protected CDNs.

Pricing (Apify pay-per-event): about **$1 per 1,000 successful downloads** on the free tier; failures free.

## Examples in this repo

| File | Use when |
|---|---|
| `examples/01-url-list.json` | You already have a short list of public file URLs |
| `examples/02-dataset-sku-names.json` | A scraper dataset has a URL column + a SKU/name column |
| `examples/03-images-only-hotlink.json` | Product images behind a CDN that checks Referer |

## How to run

1. Open [Bulk File & Image Downloader](https://apify.com/chris_elder/bulk-file-downloader) (free Apify account is enough).
2. Paste one of the example JSON files into the Actor input (or merge fields into the form).
3. Run. Download `OUTPUT.zip` from the Key-Value store when enabled.

## Demand note

Adjacent Apify Store query **“bulk image downloader”** is dominated by actors with thousands of users (e.g. onescales ~1,982 users). This Actor targets the URL→ZIP job (not HTML crawling).

## Licence

MIT for the example JSON and this README. The Actor itself is licensed on Apify.

- [`examples/05-every-image-on-pages.json`](examples/05-every-image-on-pages.json) – download every image on one or more web pages (page mode)

## Code: call it from your own scripts

- Python – URL list → `files.zip`: [`python/download_images_to_zip.py`](python/download_images_to_zip.py)
- Node – scraper dataset → ZIP named by SKU: [`node/download_from_scraper_dataset.js`](node/download_from_scraper_dataset.js)

Both use the official Apify API client and the [Bulk Image Downloader Actor](https://apify.com/chris_elder/bulk-file-downloader). Failed downloads are not charged.
