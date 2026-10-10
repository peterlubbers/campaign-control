# Pro500 Lite

A small, standalone Fictitious AI campaign for faster local and read-only Google Drive testing: **3 assets, 3 channels, 18 files total**.

| Asset | Channel | Purpose |
| --- | --- | --- |
| WEB002 | Website | Pro500 pricing |
| EML001 | Email | Start with the product decision |
| SAL-004 | Sales | The value of a shared analysis |

These are unchanged original bundles from Pro500. Each asset has five files: editable Markdown, HTML preview, publisher metadata in Markdown and JSON, and a render manifest. `campaign.json`, `brand/identity.json`, and this README bring the total to 18. Editable sources live directly in the bundles, with no duplicate `sources/` copies. No video, PDF, or native Google document is required.

## Test with Drive

Upload this entire folder, keeping its structure. Select the Drive folder with `campaign.json` directly inside it, not its parent or `assets/` subfolder. Upload completion must precede connection.

The snapshot reads **17 files**: all 15 asset files, the manifest, and brand identity. The README is not a campaign input. This is a separate campaign identity (`pro500-lite`), not the exact 104-asset sample: **Demo mode is off/unavailable; a full update covers all three assets.** It never represents approval of the full Pro500 campaign.

Use a brief such as:

> Update Pro500 to Pro1000, change the monthly price from $500 to $1,000, and remove sharing with teammates. Remove obsolete collaboration benefits, including implied promises. Preserve unrelated capabilities. Do not invent replacement features or publish anything.

AI updates still require a configured provider and make paid calls. Connecting, snapshotting, and browsing do not make AI calls. Drive originals remain read-only.

## Test locally

From the repository root, use a separate registry and unused port if another campaign is running:

```sh
CAMPAIGN_CONTROL_DATA_DIR="$HOME/.local/share/campaign-control-lite" PORT=8143 npm start -- --campaign ./fictitious-ai/campaigns/pro500-lite
```

This changes neither the saved campaign configuration nor the large Pro500 folder. The alternate-port example is for local use only; OAuth requires a matching registered callback.

Working versions, releases, and private campaign state generated during local testing are excluded from Git. The 18-file budget describes shipped inputs, not generated runs. For a clean Drive upload after local testing, upload only the files tracked in this folder, not generated or hidden state.
