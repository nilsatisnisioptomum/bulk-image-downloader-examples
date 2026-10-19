"""Bulk-download images/files into one ZIP using the Apify Actor.

Starting the Actor is billable; review its current Store pricing first:
https://apify.com/chris_elder/bulk-file-downloader

    pip install apify-client
    export APIFY_TOKEN=...   # https://console.apify.com/settings/integrations
    python download_images_to_zip.py urls.txt

Refuses an existing files.zip or symlink before starting an Actor. Download
limit: 512 MiB. ZIP detection checks the signature, not every member's integrity.
"""
import os
import sys
import urllib.request
from apify_client import ApifyClient

MAX_ZIP_BYTES = 512 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 75


def field(obj, snake, camel):  # works with apify-client v1 (dict) and v2 (model)
    return getattr(obj, snake, None) or obj[camel]


def _copy_zip(response, destination):
    size = 0
    signature = b""
    while True:
        chunk = response.read(DOWNLOAD_CHUNK_BYTES)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_ZIP_BYTES:
            raise ValueError("ZIP exceeds this example's 512 MiB limit; download it from the existing run in Console.")
        if len(signature) < 4:
            signature = (signature + chunk)[:4]
        destination.write(chunk)
    if signature == b"PK\x05\x06":
        raise ValueError("The ZIP is empty; check the existing run's input and output before retrying.")
    if signature != b"PK\x03\x04":
        raise ValueError("Response is not a ZIP; check the existing run's output before retrying.")


def download_to_zip(urls, output="files.zip"):
    # Reserve before any SDK/Actor call. O_EXCL also refuses dangling symlinks.
    output = os.path.abspath(output)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(output, flags, 0o600)
    identity = None
    destination = None
    complete = False
    try:
        identity = os.fstat(fd)
        destination = os.fdopen(fd, "wb")
        with destination:
            client = ApifyClient(os.environ["APIFY_TOKEN"])
            run = client.actor("chris_elder/bulk-file-downloader").call(run_input={
                "urls": urls,
                "createZip": True,
                "maxFiles": len(urls),
                # "onlyImages": True,  # no successful-download event for filtered files
                # "referer": "https://your-shop.example",  # for hotlink-protected CDNs
            })
            for row in client.dataset(field(run, "default_dataset_id", "defaultDatasetId")).iterate_items():
                print(row.get("url"), "->", row.get("kvKey") or row.get("key") or row.get("error"))
            zip_url = f"https://api.apify.com/v2/key-value-stores/{field(run, 'default_key_value_store_id', 'defaultKeyValueStoreId')}/records/OUTPUT.zip"
            req = urllib.request.Request(zip_url, headers={"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"})
            with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                _copy_zip(response, destination)
        # Only report success after close and while this path still names our file.
        try:
            unchanged = os.path.samestat(identity, os.lstat(output))
        except FileNotFoundError:
            unchanged = False
        if not unchanged:
            raise RuntimeError("Output file changed during download; inspect the existing run in Console before retrying.")
        complete = True
    finally:
        try:
            if destination is None:
                os.close(fd)
            elif not destination.closed:
                destination.close()
        finally:
            if not complete and identity is not None:
                try:
                    # Do not delete a file/symlink the user replaced while the run waited.
                    if os.path.samestat(identity, os.lstat(output)):
                        os.unlink(output)
                except FileNotFoundError:
                    pass
    print("Saved " + os.path.basename(output))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as source:
            urls = [line.strip() for line in source if line.strip().startswith("http")]
    else:
        urls = [
            "https://www.w3.org/Icons/w3c_home.png",
            "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        ]
    download_to_zip(urls)
