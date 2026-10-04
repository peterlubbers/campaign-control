# Campaign and AI configuration

One `campaign-control/` package contains the tool and the Fictitious AI example. [Top-level configuration](../launch-control.config.json) chooses which campaign to open and which model to use. Selecting another campaign does not copy or reorganize its existing files.

## Configuration rules

- `campaign.type`: `local` is implemented. `google-drive` is reserved and fails explicitly; no Drive access occurs.
- `campaign.path`: campaign directory containing `campaign.json`. Relative paths resolve beside the configuration file.
- `campaign.brand`: optional company identity JSON, relative to the config file. Omit for Campaign Control defaults.
- `ai.provider`: `openai` or `anthropic`.
- `ai.model`: model identifier available to your selected provider/account. Configuration does not establish access.
- `server.port`: localhost port, default 8142.

Use a private `launch-control.local.config.json` with `npm start -- --config launch-control.local.config.json` when local paths should stay out of Git. Unknown configuration fields are rejected. Keep API keys in the process environment: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Never put credentials in either configuration file.

Campaign selection precedence: `--campaign` → `LAUNCH_CAMPAIGN_DIR` → config. Command-line and environment paths resolve from the current shell directory. `LAUNCH_AI_PROVIDER`, the selected provider’s `OPENAI_MODEL` or `ANTHROPIC_MODEL`, and `PORT` override config. A different campaign override drops the config’s company theme and uses Campaign Control defaults. Select a custom config to pair that campaign with its own `campaign.brand`. Restart after config or identity changes. A provider override uses that provider’s default model unless its own model environment variable is set. See [provider behavior](profound.md).

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

The selected campaign needs write access for `working/`, `releases/`, `.launch-control/`, and the `READY-TO-PUBLISH` shortcut. Existing inputs are preserved. Every new revision reserves a fresh version; every render within it reserves a new generation. The application never overwrites a released version.

`READY-TO-PUBLISH` is a local directory symlink to `releases/vNNN`, created only after exact-content approval and final checks. A new draft or detected input/output drift removes that shortcut. Retained release folders are history, not a statement of current readiness. The app verifies files on startup, state reads, and downloads, with a local watcher while running. It cannot monitor changes while closed or continuously verify a remote Google Slides link.

The download archive and approved source snapshot remain private in `.launch-control/`; the archive contains only publisher files. Hidden state is needed to continue approval history and the approved baseline across restarts, so retain it in your private workspace backup. It is not part of the distributable example.
