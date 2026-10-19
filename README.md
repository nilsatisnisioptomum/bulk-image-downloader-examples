# Bulk image & file downloader: example inputs

Turn your product-image URLs into one ZIP, named by SKU. Use a URL list, Shopify CSV, web pages or an existing Apify scraper dataset.

**[Open the downloader on Apify](https://apify.com/chris_elder/bulk-file-downloader?utm_source=github&utm_medium=readme&utm_campaign=bulk-download-first-success)** · [See the process and FAQ](https://tools.gptshopltd.com/bulk-image-downloader/?utm_source=github&utm_medium=readme&utm_campaign=bulk-download-first-success)

You get files in run storage and, with `createZip`, an `OUTPUT.zip` archive. Your existing scraper does not need to run again: provide its **Dataset ID**, not its Run ID.

Built by [GPT Shop Ltd](https://tools.gptshopltd.com/) (UK 15766335).

## What it does

Downloads files from a URL list, a CSV / Google Sheet or an Apify dataset into the run storage, with optional ZIP. Page mode (`pageUrls`) downloads every image on one or more web pages, up to `maxImagesPerPage` per page. Image-only mode (`onlyImages`) skips non-images without a successful-download event; the Actor-start charge can still apply. Optional `referer` / `userAgent` help with hotlink-protected CDNs.

Apify runs are billable. The Store currently lists per-successful-download pricing **and an Actor-start charge**; unsuccessful file downloads do not incur a successful-download event, but a failed run is not necessarily free. Review the [live pricing](https://apify.com/chris_elder/bulk-file-downloader/pricing) before running. A free Apify account is enough to get started; free account does not mean unlimited free runs.

## Prepare a local CSV without uploading it

Have image links in a CSV on your computer? Use the free [image download planner](https://gptshopltd.com/image-download-plan/?utm_source=github&utm_medium=readme&utm_campaign=image-download-plan) to choose the image and filename columns, review the download plan, and save a separate image-job CSV or exact Actor input JSON. Your CSV contents stay in your browser; this is not a replacement Shopify import file.

The planner checks URL format, not whether links are reachable or return images. It does not download images or start an Actor run. When you are ready to use the generated input, open the downloader on your own Apify account and review its [current pricing](https://apify.com/chris_elder/bulk-file-downloader/pricing), Actor-start charge and **Max cost per run** before starting.

## First ZIP from your scraper dataset

Requires **Node.js 20+**, no package install. From the repository root:

```sh
# Safe preview: prints the input only. No token, API request or charge.
node node/download_from_scraper_dataset.js YOUR_DATASET_ID
```

The defaults look for an `images` URL/list field and a `sku` filename field, with at most 100 images. For Shopify-style fields, preview this instead:

```sh
node node/download_from_scraper_dataset.js YOUR_DATASET_ID \
  --url-field "Image Src" --name-field "Variant SKU" --max-files 20
```

Once the preview matches your dataset and you have reviewed the Store price, set `APIFY_TOKEN` in your local environment from [Apify Integrations](https://console.apify.com/account/integrations). Keep the token out of commands, screenshots and source files. Add **both** run flags deliberately:

```sh
# Billable: request a run capped at US$0.10, then save the ZIP locally.
node node/download_from_scraper_dataset.js YOUR_DATASET_ID \
  --url-field "Image Src" --name-field "Variant SKU" --max-files 20 \
  --output product-images.zip --run --max-charge-usd 0.10
```

Choose your own USD cap. The script passes it as Apify's [`maxTotalChargeUsd`](https://docs.apify.com/api/v2/actors-runs-post) run limit; a cap too small for the requested files can stop the run before all files finish. It waits for `SUCCEEDED`, downloads the ZIP using your token in an Authorization header, and prints the run link. It never overwrites an existing file. Local downloads above 512 MiB are rejected; download larger archives from Console.

If it fails, inspect the **existing run** in Console before retrying. The script never automatically retries the billable start request. Typical fixes:

| Symptom | Check |
|---|---|
| No images or an empty ZIP | The Dataset ID, exact URL field name, image URLs and `onlyImages` filter |
| HTTP 401/403 | Token permissions and access to the source dataset |
| Failed / timed-out run | Run log, source-site restrictions and charge cap |
| Destination already exists | Choose another `--output`; the existing file is preserved |

Offline verification: `npm test` and `python3 -m unittest discover -s test -p 'test_python_download.py'`. Tests use mocked SDK/network responses and temporary files; they need no real token, SDK installation or Actor runs.

## Examples in this repo

| File | Use when |
|---|---|
| `examples/01-url-list.json` | You already have a short list of public file URLs |
| `examples/02-dataset-sku-names.json` | A scraper dataset has a URL column + a SKU/name column |
| `examples/03-images-only-hotlink.json` | Product images behind a CDN that checks Referer |
| `examples/04-csv-or-google-sheet.json` | Your URLs are in a CSV or Google Sheet (e.g. Shopify `Image Src`); sample: `examples/shopify-products-sample.csv` |
| `examples/05-every-image-on-pages.json` | Download every image on one or more web pages (page mode, `pageUrls`) |

## How to run

1. Open [Bulk File & Image Downloader](https://apify.com/chris_elder/bulk-file-downloader) (free Apify account is enough).
2. Paste one of the example JSON files into the Actor input (or merge fields into the form).
3. Run. Download `OUTPUT.zip` from the Key-Value store when enabled.

## Code: call it from your own scripts

- Python – URL list → `files.zip`: [`python/download_images_to_zip.py`](python/download_images_to_zip.py)
- Node – scraper dataset → ZIP saved on your computer, named by SKU: [`node/download_from_scraper_dataset.js`](node/download_from_scraper_dataset.js). Preview first; running requires an explicit USD cap.

Python uses the Apify client; Node uses the documented Apify REST API. The Python recipe starts a billable run when executed and has no preview or spending cap; use the Node preview if you want to inspect input before running.

Python reserves `files.zip` before contacting Apify and refuses existing files or symlinks. A failed start or download removes only the newly created partial file. ZIP downloads are streamed with a 512 MiB limit and a 75-second network-operation timeout; validation checks the ZIP signature, not every archive member. Inspect the existing run in Console before retrying a failure, because a run may already have incurred charges.

## Need the product rows as well as the images?

The downloader needs a source list or dataset. If you need someone to collect the public website's data and prepare a clean CSV or Excel file, GPT Shop Ltd also offers **done-for-you website data**: Flash up to 500 rows from £49 / $59; Standard up to 5,000 rows from £149 / $179. Standard includes a scraper you can re-run on your own Apify account; those later runs are billed by Apify.

**[See a real sample and ask whether your site is feasible before paying](https://tools.gptshopltd.com/done-for-you-scraper/?utm_source=github&utm_medium=readme&utm_campaign=bulk-download-assisted-data).** Send the public URL and the columns you need. Scope, timing and refund terms are on that page; no login-only pages or access-control bypasses.

## Licence

MIT for the example JSON and this README. The Actor itself is licensed on Apify.
