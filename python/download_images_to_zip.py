"""Bulk-download images/files from a list of URLs into one ZIP using the
Apify "Bulk Image Downloader" Actor (chris_elder/bulk-file-downloader).

Why: no scraping code, retries + hotlink headers handled, failed URLs are free.
Store page: https://apify.com/chris_elder/bulk-file-downloader

    pip install apify-client
    export APIFY_TOKEN=...   # https://console.apify.com/settings/integrations
    python download_images_to_zip.py urls.txt
"""
import os, sys, urllib.request
from apify_client import ApifyClient

urls = [l.strip() for l in open(sys.argv[1]) if l.strip().startswith("http")] if len(sys.argv) > 1 else [
    "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png",
    "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
]

client = ApifyClient(os.environ["APIFY_TOKEN"])
run = client.actor("chris_elder/bulk-file-downloader").call(run_input={
    "urls": urls,
    "createZip": True,
    "maxFiles": len(urls),
    # "onlyImages": True,                      # skip non-image responses (free)
    # "referer": "https://your-shop.example",  # for CDNs that block hotlinking
})

def field(obj, snake, camel):  # works with apify-client v1 (dict) and v2 (model)
    return getattr(obj, snake, None) or obj[camel]

for row in client.dataset(field(run, "default_dataset_id", "defaultDatasetId")).iterate_items():
    print(row.get("url"), "->", row.get("kvKey") or row.get("key") or row.get("error"))

zip_url = f"https://api.apify.com/v2/key-value-stores/{field(run, 'default_key_value_store_id', 'defaultKeyValueStoreId')}/records/OUTPUT.zip"
req = urllib.request.Request(zip_url, headers={"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"})
with urllib.request.urlopen(req) as r, open("files.zip", "wb") as f:
    f.write(r.read())
print("Saved files.zip")
