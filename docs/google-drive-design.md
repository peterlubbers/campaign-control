# Google Drive operating design

**Phase one is implemented** as read-only Drive launches: OAuth with the read-only scope, a verified private snapshot of one authorized campaign folder, per-launch isolation, refresh with drift detection, and disconnect. [Setup and operation](google-drive-setup.md).

The design below was authored October 3, 2026 at 18:03:29 UTC / 11:03:29 a.m. America/Los_Angeles during the authorized build. Sections marked **Implemented** describe shipping behavior; **Design only** describes work that remains unbuilt: write-back to Drive, continuous monitoring, Drive-side release packaging, live native-Slides revalidation, hosted multi-user workspaces, and folder discovery.

Use Drive as the campaign’s source library and collaboration surface, with an explicit **scan, snapshot, review, and package** workflow. Keep the existing candidate approval model. Continuous synchronization adds complexity without improving the first demonstration.

**Confidence: High.** Expected impact: less file gathering and fewer handoff mistakes for teams already using Drive. The tradeoff is additional work to detect concurrent edits, incomplete access, and differences between native documents and exported representations.

## One asset, several representations

The campaign manifest remains the inventory of required deliverables. Identify a remote source by its Drive file ID, not its display name or folder path. Record the observed revision marker when available, observation time, and hashes of the exact retained content and review exports. A file ID alone does not identify approved content.

| Representation | Responsibility | Status |
| --- | --- | --- |
| Native Google Slides or Docs | Canonical editable source; preserve original files. All presentations remain native Google Slides. | Design only. Phase one records them as unsupported, writes no bytes, and blocks release until an exported or uploaded representation is inventoried. |
| Uploaded video, image, or other file | Preserve the original bytes and capture a content hash. | Implemented. Snapshot copies are verified by size, checksum, and revision marker. |
| Review export | Retain the exact representation inspected by checks and the human reviewer. | Implemented. Review reads the verified snapshot, not the live Drive file. |
| Publisher metadata | Keep title, description, audience instructions, captions, and other companions attached to the same asset ID. | Implemented. Companions resolve through the campaign manifest inside the snapshot. |
| Candidate manifest | Bind source identities, confirmed product facts, evidence, candidate content, companions, checks, and reviewer decision together. | Implemented, extended with the snapshot identity and drift state. |

Exports are companions to native documents. They do not replace the editable source or count as additional deliverables.

## Folders with clear responsibilities

Within a user-selected campaign location, use the same team-facing stages as the local workspace:

```text
sources/                        Native documents and editable inputs, when available
assets/<channel>/<asset name>/   Existing campaign media and companions
working/v001/                   Candidate copies, previews, and review evidence
releases/v001/                  Approved publisher files, excluding authoring sources
READY-TO-PUBLISH                 Current approved release reference
raw-material/                   Supporting inputs when needed; outside asset counts
```

**Implemented locally per launch:** the snapshot reproduces the campaign folder’s shape inside the launch’s private local storage, and the workflow creates `working/`, `releases/`, and the ready reference there. No folder, copy, or move is created in Drive itself.

**Design only:** writing these stages back into Drive. That would require explicit permission for the specific operations and destinations, verification of destination access before placing content there (a new Drive folder is not assumed private), and no overwrite or reorganization of originals as an incidental consequence of inspection. Publishing and changes to sharing remain separate, unauthorized actions.

Keep content hashes and remote revision IDs in manifests, with readable asset names and version labels for navigation. A folder name alone never proves approval. For Drive, a ready reference would use a Drive shortcut or an explicit manifest reference, not a filesystem symlink; the shipped ready reference stays local to the snapshot. Starting a new version clears readiness while retaining previous releases. Phase one creates and moves no Drive content.

## Review the snapshot, then verify it again

1. Inspect every registered asset. A required unreadable file is a coverage failure, not an omission from the denominator.
2. Capture source identity and content before creating authorized working copies. Record failures visibly.
3. Produce candidate representations and metadata, then check the exact retained content. Native edits and companion exports must agree.
4. Recheck source and candidate identities before approval. If a document changed since inventory, show the conflict and require a refreshed candidate and review. Do not silently merge it.
5. Record the human decision against the candidate fingerprint. Recheck before packaging and package only the approved retained content. An edit invalidates approval.

Steps 1–5 ship for a snapshot: unreadable, ambiguous, oversized, shortcut, and native-document files are recorded as visible failures; snapshot identity travels with the run; drift between index, download, and verification is reported instead of merged; and approval binds to the exact retained bytes. The one step that cannot ship locally is proving that a **live** native presentation still matches its recorded review, because phase one retains exports rather than revalidating Drive.

## Current boundary

**Implemented.** The chooser, not the configuration file, adds a Drive launch: `campaign.type: "google-drive"` in `campaign-control.config.json` is rejected with a pointer to the chooser, because the launch registry lives in private application data. Credentials and authorization stay server-side, outside documents, logs, browser bundles, and version control. The integration grants no permission to upload, share, publish, or change campaign facts, and it starts from one explicitly authorized campaign folder snapshot.

Native Google documents and shortcuts are recorded as unsupported with no bytes written; they appear in review as blockers. A Drive launch therefore reviews exported or uploaded representations, and its local checks cannot prove that a remotely edited presentation still matches its recorded review.

**Design only.** Write-back to Drive, continuous monitoring or background sync, Drive-side release packaging and a Drive ready-reference, live native-Slides revalidation, hosted multi-user workspaces, and Drive folder discovery. Until remote revalidation is implemented and tested, that gap stays explicit in review rather than implied by the snapshot. The local `READY-TO-PUBLISH` symlink remains local-only: a Drive ready reference would use a Drive shortcut or an explicit manifest reference.
