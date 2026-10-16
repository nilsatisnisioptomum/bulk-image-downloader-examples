// Download every product image from a previous Apify scraper run (e.g. a Shopify / Amazon
// scraper) into one ZIP, named by SKU.  npm i apify-client ; APIFY_TOKEN=... node download_from_scraper_dataset.js <datasetId>
// Actor: https://apify.com/chris_elder/bulk-file-downloader
import { ApifyClient } from 'apify-client';
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const run = await client.actor('chris_elder/bulk-file-downloader').call({
    datasetId: process.argv[2],   // the scraper run's defaultDatasetId (not the run ID)
    urlField: 'images',           // field holding one URL or a list of URLs; dots reach nested fields
    fileNameField: 'sku',         // optional: sku.jpg, sku-1.jpg ...
    onlyImages: true,
    createZip: true,
    maxFiles: 1000,
});
console.log(`ZIP: https://api.apify.com/v2/key-value-stores/${run.defaultKeyValueStoreId}/records/OUTPUT.zip`);
