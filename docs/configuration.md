# Campaign and AI configuration

One `campaign-control/` package contains the tool and the Fictitious AI example. [Top-level configuration](../campaign-control.config.json) chooses which campaign to open and internally persists the model saved through **AI settings**. Selecting another campaign does not copy or reorganize its existing files.

## Configuration rules

- `campaign.type`: `local` is the only implemented value here. A Drive campaign is **not** selected in this file; add it from the launch chooser, which records it in private application data. `google-drive` in this file fails with an explanatory error and performs no Drive access. [Google Drive setup](google-drive-setup.md).
- `campaign.path`: campaign directory containing `campaign.json`. Relative paths resolve beside the configuration file.
- `campaign.brand`: optional company identity JSON, relative to the config file. Omit for Campaign Control defaults.
- `ai.provider` and `ai.model`: internal persistence for the app’s last successfully saved provider/model choice. Use the in-app picker, not JSON editing. Saving does not establish account access.
- `server.port`: localhost port, default 8142.

Use a private `campaign-control.local.config.json` with `npm start -- --config campaign-control.local.config.json` when local paths should stay out of Git. Unknown configuration fields are rejected. Keep API keys in the process environment: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Never put credentials in either configuration file.

Campaign selection precedence: `--campaign` → `CAMPAIGN_CONTROL_CAMPAIGN_DIR` (legacy `LAUNCH_CAMPAIGN_DIR` still accepted) → config. Command-line and environment paths resolve from the current shell directory. `PORT` still overrides the configured port. A different campaign override drops the config’s company theme and uses Campaign Control defaults. Select a custom config to pair that campaign with its own `campaign.brand`. Restart after campaign, server or identity changes; saving AI selection needs no restart.

**Compatibility change, October 7:** saved app AI settings now take precedence. `CAMPAIGN_CONTROL_AI_PROVIDER`, the legacy `LAUNCH_AI_PROVIDER`, `OPENAI_MODEL`, and `ANTHROPIC_MODEL` do not select models, including in `scripts/check-ai.mjs`; startup and settings show their names as ignored, never their values. Credentials, `--config`, campaign overrides, `PORT`, `CAMPAIGN_CONTROL_AI_BATCH_SIZE`, `CAMPAIGN_CONTROL_AI_CONCURRENCY`, and `CAMPAIGN_CONTROL_AI_TIMEOUT_MS` remain supported; their `LAUNCH_AI_*` predecessors are still read when the new name is unset. Provider/model arguments are passed explicitly to adapters; the app does not mutate the process environment.

**Save/Cancel:** selecting a provider requires explicitly choosing one of its models. Save accepts only a catalog provider/model pair, atomically replaces the active config (following a config symlink), and retains other configuration values. Failure keeps the previous file and selection. Concurrent saves and runs share a lock. Cancel closes settings without saving. An unconfigured provider can be saved; its server credential is required before any run starts. An unlisted saved identifier stays visible and is never silently replaced.

**Run identity:** a new run resolves its saved choice to a concrete ID and records the catalog version before its first model request. Later corrections, checks, and restarts use that ID even when the picker or catalog changes. Request-level returned IDs remain evidence. New runs include their model binding in candidate identity; legacy hashes are not migrated. Ambiguous legacy provenance blocks further AI operations without invalidating otherwise-valid viewing, human review, approval, or downloads. A missing credential for a previous version requires that version’s provider credential, not a fallback.

See [verified model catalog and pricing](ai-models.md) and [provider behavior](profound.md).

## Map existing files

A minimal `campaign.json` inventory can map existing paths without adopting the example’s folder names:

```json
{
  "id": "example-launch",
  "name": "Example campaign",
  "facts": {"product": "Starter", "monthlyPrice": 100, "sharing": false, "maxTeammates": 0},
  "assets": [
    {
      "id": "WEB-001",
      "title": "Product landing page",
      "channel": "website",
      "kind": "page",
      "source": "team-copy/landing.md",
      "files": [{"path": "existing-media/landing.html", "mime": "text/html", "role": "review-preview"}],
      "required": true
    }
  ]
}
```

All referenced files must remain inside the selected campaign directory; escaping symlinks and traversal are rejected. Sources currently support UTF-8 `.md` or `.txt` with the required channel-specific publisher metadata. See [renderer format](media.md). `source` can be absent for inventory and existing-media previews, but a required asset without supported editable copy blocks automated revision and release. A standalone binary replacement workflow is not implemented.

`files` records existing representations; it does not prove approval or make a file eligible for release. The first file is the default existing preview. Current rendering supports `page`, `copy`, `graphic`, `video`, and `sales`; channel names follow the eleven channels in the included manifest. The current commercial-change schema covers product name, monthly price, and sharing allowance.

Optional `marketEvidencePath` resolves inside the campaign’s `evidence/` directory. The interface preloads the fictional demo brief; replace it with the desired change when connecting another campaign. The human still confirms each interpreted target fact.

## Storage and versions

The selected campaign needs write access for `working/`, `releases/`, `.campaign-control/`, and the `READY-TO-PUBLISH` shortcut. Existing inputs are preserved. Every new revision reserves a fresh version; every render within it reserves a new generation. The application never overwrites a released version.

`READY-TO-PUBLISH` is a local directory symlink to `releases/vNNN`, created only after exact-content approval and final checks. A new draft or detected input/output drift removes that shortcut. Retained release folders are history, not a statement of current readiness. The app verifies files on startup, state reads, and downloads, with a local watcher while running. It cannot monitor changes while closed or continuously verify a remote Google Slides link.

The download archive and approved source snapshot remain private in `.campaign-control/`; the archive contains only publisher files. Hidden state is needed to continue approval history and the approved baseline across restarts, so retain it in your private workspace backup. It is not part of the distributable example.

## Launches and Drive credentials

Launches are not configuration-file entries. The chooser lists every launch in the workspace: the default local launch, local campaigns added there, and Google Drive campaigns. Launch records live in the private application data directory (`CAMPAIGN_CONTROL_DATA_DIR`, else `$XDG_DATA_HOME/campaign-control`, else `~/.local/share/campaign-control`) as atomic `0600` JSON inside `0700` directories. Connection tokens live there too and never in this package.

Google credentials follow the same rule as provider keys: process environment only. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are required for a Drive launch, and `GOOGLE_REDIRECT_URI` defaults to `http://127.0.0.1:8142/oauth/google/callback` on a registered `127.0.0.1`, `localhost`, or `[::1]` callback path. Never put them in either configuration file. A Drive snapshot is a read-only copy: the campaign folder in Drive is never written to, and each launch keeps its own snapshot, artifacts, state, and drafts. See [Google Drive setup](google-drive-setup.md).
