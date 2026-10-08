# Google Drive operating design

**Proposed extension, not implemented.** Authored October 3, 2026 at 18:03:29 UTC / 11:03:29 a.m. America/Los_Angeles during the authorized build.

Use Drive as the campaign’s source library and collaboration surface, with an explicit **scan, snapshot, review, and package** workflow. Keep the existing candidate approval model. Continuous synchronization adds complexity without improving the first demonstration.

**Confidence: High.** Expected impact: less file gathering and fewer handoff mistakes for teams already using Drive. The tradeoff is additional work to detect concurrent edits, incomplete access, and differences between native documents and exported representations.

## One asset, several representations

The campaign manifest remains the inventory of required deliverables. Identify a remote source by its Drive file ID, not its display name or folder path. Record the observed revision marker when available, observation time, and hashes of the exact retained content and review exports. A file ID alone does not identify approved content.

| Representation | Proposed responsibility |
| --- | --- |
| Native Google Slides or Docs | Canonical editable source; preserve original files. All presentations remain native Google Slides. |
| Uploaded video, image, or other file | Preserve the original bytes and capture a content hash. |
| Review export | Retain the exact representation inspected by checks and the human reviewer. |
| Publisher metadata | Keep title, description, audience instructions, captions, and other companions attached to the same asset ID. |
| Candidate manifest | Bind source identities, confirmed product facts, evidence, candidate content, companions, checks, and reviewer decision together. |

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

Create folders, copy files, or move files only with explicit permission for those operations and destinations. Never overwrite or reorganize originals as an incidental consequence of inspection. Verify destination access before placing content there; do not assume a new folder is private. Publishing and changes to sharing remain separate, unauthorized actions.

Keep content hashes and remote revision IDs in manifests, with readable asset names and version labels for navigation. A folder name alone never proves approval. For Drive, the ready reference would use a Drive shortcut or an explicit manifest reference, not a filesystem symlink. Starting a new version would clear readiness while retaining previous releases. This is a Drive design only; the local folder change does not create or move any Drive content.

## Review the snapshot, then verify it again

1. Inspect every registered asset. A required unreadable file is a coverage failure, not an omission from the denominator.
2. Capture source identity and content before creating authorized working copies. Record failures visibly.
3. Produce candidate representations and metadata, then check the exact retained content. Native edits and companion exports must agree.
4. Recheck source and candidate identities before approval. If a document changed since inventory, show the conflict and require a refreshed candidate and review. Do not silently merge it.
5. Record the human decision against the candidate fingerprint. Recheck before packaging and package only the approved retained content. An edit invalidates approval.

## Current boundary

The top-level `campaign-control.config.json` selects the local campaign. A future `campaign: {type: "google-drive", folderId: "…"}` setting will select the remote location; today it fails with an explicit not-implemented error. The current application coordinates local files. Native Slides references and their verification are manually supplied; this is not a Drive connector or continuous remote verification. A live Slides link can drift after inspection. Current local checks cannot prove that a remotely edited presentation still matches its recorded review. That gap must remain explicit until remote revalidation is implemented and tested.

A future Drive adapter keeps credentials and authorization server-side, outside documents, logs, browser bundles, and version control. It grants no automatic permission to upload, share, publish, or change campaign facts. Start with one explicitly authorized campaign snapshot, including all 104 deliverables, before considering background monitoring.
