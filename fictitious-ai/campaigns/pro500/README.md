# Pro500 campaign

**104 deliverables across 11 channels.** Fictitious AI is the fictional product analytics company; Pro500 is its current offer. Pro1000 is the requested revision.

## Where to go

| Folder | Use |
| --- | --- |
| [sources/](sources/) | Editable campaign copy and publisher metadata, listed in [campaign.json](campaign.json). Start here to change an input. |
| [assets/](assets/) | Existing campaign media and previews, grouped by channel and named asset. These are the Pro500 baseline for comparison. |
| `working/v001/` | Candidate revisions and review files. Each new version starts as Draft. |
| `releases/v001/` | Approved deliverables and publisher companions, without editable source or review evidence. |
| `READY-TO-PUBLISH` | Shortcut to the current approved release; removed when a new version starts or readiness is invalidated. |
| `evidence/` (optional) | Your permitted market context. Private hackathon observations are not distributed. |

Inside an asset folder, `v01`, `v02`, and so on distinguish render versions without overwriting reviewed files. The newest numbered version is the latest render; release approval is a separate decision. Each version keeps its media, captions, metadata, and exact source snapshot together. Edit the master in `sources/`, not its generated snapshot.

App state and audit history live in hidden `.launch-control/`. File fingerprints remain in manifests for verification; nobody needs to navigate hash-named folders. The included existing media is part of the package. Working versions, releases, readiness shortcuts, and private app state are excluded from Git.

## Videos

Six actual 18-second, 720p silent motion graphics. Each folder also contains captions, thumbnails, and YouTube metadata.

- **VID-001 — Meet Fictitious AI product analytics:** [MP4](assets/video/VID-001-meet-fictitious-ai-product-analytics/v01/video.mp4) · [YouTube metadata](assets/video/VID-001-meet-fictitious-ai-product-analytics/v01/youtube-metadata.md)
- **VID-002 — Define the event before reading the chart:** [MP4](assets/video/VID-002-define-the-event-before-reading-the-chart/v01/video.mp4) · [YouTube metadata](assets/video/VID-002-define-the-event-before-reading-the-chart/v01/youtube-metadata.md)
- **VID-003 — Look at the step where users stop:** [MP4](assets/video/VID-003-look-at-the-step-where-users-stop/v01/video.mp4) · [YouTube metadata](assets/video/VID-003-look-at-the-step-where-users-stop/v01/youtube-metadata.md)
- **VID-004 — Retention starts with a return definition:** [MP4](assets/video/VID-004-retention-starts-with-a-return-definition/v01/video.mp4) · [YouTube metadata](assets/video/VID-004-retention-starts-with-a-return-definition/v01/youtube-metadata.md)
- **VID-005 — Give the cohort comparison a reason:** [MP4](assets/video/VID-005-give-the-cohort-comparison-a-reason/v01/video.mp4) · [YouTube metadata](assets/video/VID-005-give-the-cohort-comparison-a-reason/v01/youtube-metadata.md)
- **VID-006 — From a plain-language question to review:** [MP4](assets/video/VID-006-from-a-plain-language-question-to-review/v01/video.mp4) · [YouTube metadata](assets/video/VID-006-from-a-plain-language-question-to-review/v01/youtube-metadata.md)

Pro1000 drafts and approved releases are runtime artifacts. A draft is not an approved release. Starting a new version preserves previous releases. Full approved releases can advance the copy baseline; partial releases retain the original campaign baseline. Original editable inputs are retained.

## Sales battlecard

SAL-001 is a PDF battlecard covering discovery, the current offer, evaluation and next steps. Its editable source is `sources/sales/sal-001.md`; `campaign.json` selects the active PDF bundle. Revised copy is rendered into a new PDF and checked before approval. The demo presentation is separate and remains in Google Slides.
