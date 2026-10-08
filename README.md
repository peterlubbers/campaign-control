<img src="brand/relay-mark.svg" width="64" height="64" alt="Campaign Control Relay logo">

# Campaign Control

**Agentic campaign updates.**<br>
**Inhuman scale. Human control.**

A reusable campaign workbench: connect a campaign folder, describe a product change, review AI revisions and checks, then approve an exact version for the publishing team. Publishing stays with people.

Built at the **Profound Marketing Engineering Hackathon**.

![Choose a provider and model; bring your own campaign files, facts and brand; interpret, revise, audit, then obtain human approval for an exact publisher package.](docs/diagrams/campaign-control-architecture.svg)

## One package, your campaign

```text
campaign-control/
├── launch-control.config.json   Internal campaign/server config and saved AI choice
├── server.mjs, lib/, web/        The application
├── fictitious-ai/              Included fictional company example
│   ├── brand/                  Its identity, colors, and logo
│   └── campaigns/pro500/
│       ├── campaign.json       Asset inventory and product facts
│       ├── sources/            Editable inputs, where available
│       ├── assets/             Existing media and publisher metadata
│       ├── evidence/           Optional context you supply
│       ├── working/v001/       Candidate revisions and review files*
│       ├── releases/v001/      Approved publisher deliverables*
│       └── READY-TO-PUBLISH    Shortcut to the current approved release*
├── brand/                      Campaign Control default identity
├── docs/                       Design, research, and measurement
└── presentation/               Google Slides link and architecture preview
```

`*` Created by the workflow. Private state and approval history stay in the campaign’s hidden `.launch-control/` folder. The example media ships with the package; working versions, releases, private state, and readiness shortcuts are excluded from Git.

## Run locally

Requires **Node.js 22+**. Generating new videos or PDF collateral also requires **macOS and Swift/Xcode Command Line Tools**; the included MP4s and PDF are already rendered. No additional PDF package is needed.

Run `npm start` from this directory. Open [localhost:8142](http://127.0.0.1:8142), then choose **AI settings** in the header. Select OpenAI or Anthropic, choose a model, and **Save selection**. **Cancel** discards unsaved changes. Sol, Astra, Luna, Opus, Fable and Haiku show their version, actual API ID, and a factual description. Saving makes no model call and requires no manual JSON editing.

Configure `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` securely in the server environment before running AI updates. There are no key inputs in the app. Credential presence is not verified model access. Browsing and saving work without credentials; starting a run does not. The app does not automatically load `.env`.

The last successfully saved choice returns after restart. [launch-control.config.json](launch-control.config.json) is internal persistence; the app updates only `ai.provider` and `ai.model`. Campaign, brand, and server settings remain intact. The optional `campaign.brand` still selects a company theme. [Brand ownership](docs/brand.md).

Point to an existing local campaign without moving its files:

```sh
npm start -- --campaign "/path/to/your/campaign"
```

That folder needs a `campaign.json` inventory mapping its current files. Editable sources are optional in the inventory; revising a required asset still needs a supported Markdown/plain-text source and renderer. Unsupported assets remain visible and block release. [Campaign mapping and configuration](docs/configuration.md).

OpenAI is the shipped default; Anthropic is also supported. **Google Drive is a planned connector.** Selecting it currently returns a clear error. [Drive design](docs/google-drive-design.md).

### Model selection and existing versions

For the Fable model used in the hackathon demo, choose **Anthropic → Fable** in **AI settings** and save. Its current documented ID is `claude-fable-5-1`; account access is not guaranteed by its presence in the picker.

Saved app settings are authoritative. `LAUNCH_AI_PROVIDER`, `OPENAI_MODEL`, and `ANTHROPIC_MODEL` are ignored with a notice naming the variables, never their values. Campaign overrides, `--config`, `PORT`, batching and timeout variables still work.

Selection changes lock during processing and saving. Each run records its concrete provider/model before its first request; corrections and audits keep that model across restarts. **Next update’s model** and **This version’s model** are separate. Unlisted saved choices remain visible and need an explicit replacement before a new run. Ambiguous legacy provenance blocks further AI operations only, not viewing or valid approved downloads.

The six-model catalog was checked against official documentation on **October 7, 2026**, after the hackathon. It changes through reviewed, tested app releases, not automatically. Pricing and maintenance details stay under **Model details and maintenance** in settings. [Catalog sources and maintenance](docs/ai-models.md).

## Draft → review → ready to publish

1. Open **Campaign Control**, choose **Pro500**, and let it check the existing inventory. The dashboard shows campaign readiness and counts; **Browse assets** opens all 104 assets.
2. Choose **Make an update** below the divider to reveal Maya’s preloaded, editable brief and release scope. Opening or hiding the brief makes no AI request and preserves your edits. That exact text goes to AI only when you choose **Update campaign**; AI interprets the requested facts before revising anything. Ambiguities stop the run.
3. **Demo mode**, beside **Local** in the header, defaults to on for fresh sessions of the bundled example: the next update covers four demo assets and their publisher files — website WEB002, video VID-001, social SOC-001, and sales SAL-004 — while the other 100 assets stay unchanged. The release-scope panel shows the exact split, "4 demo assets of 104," before you start. Switch it off to process the full 104-asset campaign; the panel then shows all 104 assets. The switch selects only the next update and never changes an existing version's recorded scope.
4. **Update campaign** creates `working/v001/`. Watch actual proposal, output, and audit counts plus processing time. Timing includes interpretation and corrections, excludes human review, and remains visible with the results.
5. Review the four before/after bundles, identified by asset ID and format. Use **Request revision** to describe a correction to one asset. AI revises that candidate, produces new files, and reruns the included campaign's checks; all review marks and approval reset. Earlier files and other asset outputs stay intact. Edits you type into a candidate source are kept as clearly marked unsaved drafts across refreshes, re-renders, and asset navigation; marking an asset reviewed or approving the release requires saving or explicitly discarding them, and a candidate that changes underneath a draft surfaces it instead of silently reapplying it. Then mark the assets reviewed, confirm the interpreted facts, enter your name, and approve the exact version. Unresolved required findings prevent approval. Their IDs, reasons, and **Review issue** buttons appear beside approval. **Browse all included assets** opens the full inventory; filter **Needs attention** to find every blocker, including assets outside the four examples.
6. Download the publisher package or copy its folder path. `releases/v001/` and `READY-TO-PUBLISH` appear only after approval. Nothing is published.

Releases contain finished copy/media, metadata, captions, thumbnails, and an approval manifest. Sources and review evidence stay in the workspace. The home card reflects current readiness: updating, awaiting approval, needs attention, or launch ready. Demo releases are explicitly partial: their manifests record all exclusions and they never count as full-campaign approval. Both modes use the same live AI, output checks, and human approval. Demo mode does not supply canned results. The toggle selects the next update, locks during processing and result review, and returns to on for the bundled example on every page reload (off for other campaign folders); an existing version always retains its recorded scope.

Asset feedback supports copy, publisher metadata, and the category label above ordinary HTML copy previews. For example: “Remove the duplicate SALES entry in the preview category label. Keep the rest unchanged.” That label belongs to the review preview, not the publisher's Markdown. Unsupported layout, footage, or native Slides requests remain blocked. **Reject version** records a rejection of the entire version; it does not send an asset correction to AI. The UI calls the included silent animated MP4s **Motion assets**; their inventory channel remains `video`.

For a fresh rehearsal, select **Reset demo** in the footer and **Archive & reset demo**. The bundled example returns to the original Pro500 inventory: no active revision, review marks, approval, release download, or readiness shortcut. The next update starts at `v001`; the brief resets and Demo mode returns to its fresh-session default: on. Original sources/media, brand, model settings and server credentials are preserved. Generated work and previous state move to `.launch-control/demo-archives/reset-001/` (then `reset-002`, etc.), excluded from Git and inaccessible through the app's artifact routes. This is a recoverable archive, not permanent deletion. The reset is unavailable during processing or for an external campaign folder. Restart the server after backend changes, then refresh the page to load the controls.

Starting another version clears current readiness and retains earlier releases. Full releases can become the next revision’s baseline; a partial release does not advance commercial facts across unrevised assets, so its next version starts from the campaign inputs. Input or output changes invalidate readiness when detected, on startup, and before download. Changes while the app is closed cannot clear a shortcut until it runs again.

If an AI audit flags a judgment you disagree with, use **Override AI finding**, enter your name and reason, and continue. The original finding stays visible and travels with the release record. **Exclude from launch** removes an asset and its companions from this release, with an explicit reason; **Include again** restores it. These decisions preserve completed reviews of unchanged assets. A representative asset you explicitly override is marked reviewed. Final release approval is still a separate human action. Missing files, failed output checks, and stale content cannot be overridden. Rechecking invalidates prior AI overrides. An excluded asset makes the package partial; it does not silently advance the whole campaign's product facts.

## Included example

**Fictitious AI**, a fictional product analytics company, changes **Pro500 → Pro1000**, **$500 → $1,000/month**, and **removes sharing** across **104 deliverables in 11 channels**. All originals include publisher metadata; there are six actual motion MP4s and a PDF sales battlecard. Neutral publisher routes keep the demo focused on offer changes rather than URL migration. The separate hackathon presentation remains in Google Slides. [Explore the campaign](fictitious-ai/campaigns/pro500/README.md).

The challenge exceeds find-and-replace: removing sharing can invalidate a promise that a colleague can continue an analysis. The hackathon demo used manually observed buyer-question context from the assigned Profound Mixpanel dataset. Those private observations are omitted from this public example; the workflow runs without them. You can supply permitted evidence from your own campaign. [Evidence workflow](docs/mixpanel-use.md).

## Verified runs and boundaries

Observed live runs at the October 3, 2026 hackathon:

| Provider / model | Scope | Processing time | Observed API cost (USD) | Outcome |
| --- | --- | ---: | ---: | --- |
| OpenAI · `gpt-6.1-sol` | Four-asset walkthrough | 33.1 seconds | ~$0.04 | Ready for human review |
| Anthropic · Fable 5.1 (`claude-fable-5-1`) | Four-asset walkthrough | 81.3 seconds | ~$0.46 | Ready for human review |
| OpenAI · `gpt-6.1-sol` | Full campaign: 104 assets, 11 channels | 4 minutes 26.9 seconds | Not separately measured | All automated checks passed; human approval produced the complete package |
| Anthropic · Fable 5.1 (`claude-fable-5-1`) | Full campaign: 104 assets, 11 channels | TBD | TBD | Not yet run |

Processing time includes brief interpretation, AI revisions, rendering and checks; it excludes human review and packaging. A later OpenAI four-asset run completed in 34.2 seconds; its cost was not separately captured. The full run used 27 model requests with no retries.

Costs are operator-reported billing observations, not instrumented per-run charges. The Fable estimate reflects the billing increase during that demo and assumes no unrelated usage. These individual runs are not a controlled model comparison, a performance guarantee or measured business savings. Model latency, output and cost vary. Private run history and approved outputs are not distributed as precomputed results.

Run `npm test` for the automated checks. They use isolated synthetic providers and temporary campaigns, not paid API calls. The live asset-specific feedback stage still needs a separate model rehearsal; its software contracts are covered by automated tests.

**Implemented:** local campaign inventories, OpenAI/Anthropic adapters, bounded parallel calls, editable briefs, text and publisher-metadata revisions, native output generation, independent audits, asset feedback, human overrides/exclusions, and approval bound to exact files.

**Planned:** Google Drive, Slack and Notion connectors; additional provider adapters; dedicated autonomous subagents. The architecture illustration includes planned connections. The Profound API adapter is optional and has not been verified against a live account; the hackathon evidence was observed manually.

[Configuration](docs/configuration.md) · [Media formats](docs/media.md) · [Measurement plan](docs/campaign-scale-research.md) · [Public package and authorship](docs/public-package.md) · [Presentation](presentation/README.md)

## License

[Zero-Clause BSD (0BSD)](LICENSE). Use, modify and redistribute the original code and fictional example without an attribution requirement. Third-party services and trademarks retain their own terms.
