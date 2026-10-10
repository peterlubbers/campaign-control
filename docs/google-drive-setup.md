# Google Drive launch setup

**Implemented.** A Drive launch reads a campaign folder in Google Drive through a private, recorded snapshot. Campaign Control never writes to Drive, never changes sharing, and never publishes.

Credentials stay in the server process environment. Tokens, launch records, and snapshots stay in this machine’s private application data, outside campaign folders, logs, browser bundles, and version control.

## What a Drive launch does

1. **Connect** once, with the read-only Drive scope.
2. **Choose** the Drive folder that contains `campaign.json`.
3. **Snapshot** the referenced files into private local storage. Every file is verified by size, checksum, and revision marker before it counts.
4. **Review** the snapshot exactly like a local campaign: one launch identity, its own artifacts, state, and unsaved drafts.
5. **Refresh** on demand. A refresh replaces the snapshot, archives the previous run to history, and reports drift instead of silently merging it.
6. **Disconnect** any time. Disconnecting revokes the Google grant and deletes the local token.

Each launch is isolated: opening a Drive campaign never shows another launch’s run, review marks, drafts, or artifacts. Campaign Control processes one campaign update at a time per workspace; other launches show a busy notice until the current operation finishes.

## Prerequisites

- **Node.js 22+** and this package.
- A **Google account** that can already read the campaign folder.
- A Drive folder holding a campaign inventory: `campaign.json` plus the files it references. See [Campaign mapping](configuration.md).
- A **Google Cloud project** where you can create an OAuth client (about five minutes, free).

## 1. Create the OAuth client

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create or select a project.
2. **APIs & Services → Library**, search for **Google Drive API**, and enable it.
3. **APIs & Services → OAuth consent screen**: choose **External**, add your own Google account under **Test users**, and save. Testing mode is sufficient; Campaign Control needs no Google verification review because it requests a single read-only scope for your own account.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
5. Under **Authorized redirect URIs**, add exactly:

   ```text
   http://127.0.0.1:8142/oauth/google/callback
   ```

6. Copy the **client ID** and **client secret**.

The callback must be plain `http` on `127.0.0.1`, `localhost`, or `[::1]`, with the path `/oauth/google/callback`. Campaign Control refuses to start an authorization that does not match, so a mismatched redirect URI fails loudly instead of leaking a code elsewhere. If you change the port, update both `PORT` and the redirect URI.

## 2. Set environment variables

```sh
export GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="…"
npm start
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Yes | OAuth client ID from the step above. |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth client secret. Server-side only; never sent to the browser. |
| `GOOGLE_REDIRECT_URI` | No | Defaults to `http://127.0.0.1:8142/oauth/google/callback`. Set it only when the port or host differs. |
| `CAMPAIGN_CONTROL_DATA_DIR` | No | Private storage for launches, tokens, and snapshots. Defaults to `$XDG_DATA_HOME/campaign-control` or `~/.local/share/campaign-control`. |
| `PORT` | No | Server port, default `8142`. Must match the redirect URI. |

Put these in the server environment, not in `campaign-control.config.json`. Without all of them, the chooser states plainly that Drive is not configured and keeps local campaigns working.

## 3. Connect and add the launch

1. Start the server and open [localhost:8142](http://127.0.0.1:8142). The homepage is the **launch chooser**.
2. Under **Add a launch → Connect a Google Drive campaign**, choose **Connect Google Drive**. The browser goes to Google consent.
3. Google shows the read-only Drive scope. Consent is recorded; Campaign Control can read all Drive files available to your account, while the application itself reads only inside the folder you choose next.
4. Back in Campaign Control, paste the **folder ID or full folder URL** that contains `campaign.json`.
5. **Add Google Drive launch** starts a durable snapshot job. The folder form stays busy and prevents duplicate submissions while it reports folders inspected, items found, and file-copy and verification counts. Large campaigns can take several minutes. On success, the launch card shows the campaign name, asset count, readiness, and the last successful refresh time.

The snapshot runs as a restartable job: progress is recorded, and a job interrupted by a server restart is reported as interrupted rather than silently lost.

## What is copied, and where

Drive content is copied into the launch’s private snapshot directory under the application data directory: the registry and connection tokens are `0600` files in `0700` directories. Original Drive files are never modified, moved, renamed, or shared; the source folder stays exactly as it was. Nothing is uploaded anywhere.

## Snapshot rules and limits

| Rule | Behavior |
| --- | --- |
| Per-file limit | 250 MB. A larger referenced file fails the snapshot with the offending path. |
| Total limit | 1 GB for one snapshot. |
| Identity | Recorded per file: Drive file ID, parent, name, revision/version marker, modified time, size, MIME type, MD5, and the sha256 of the retained bytes. |
| Ambiguity | Two files with the same name in the same folder are reported as ambiguous instead of guessing. |
| Missing or unreadable | A missing or unreadable required file is a coverage failure, not an omission from the denominator. |
| Native Google documents and shortcuts | Docs, Slides, Sheets, and shortcuts are recorded as unsupported, with no bytes written. They appear in review as blockers and prevent release. |
| Interrupted download | A partial download fails the snapshot and writes no candidate file. |
| Checksum mismatch | A file whose bytes do not match its Drive checksum fails the snapshot. |
| Drift | A file that changes between index read and download, or between download and verification, is reported as drift with the file path. |

## Refresh, drift, and disconnect

- **Refresh** re-reads the folder as a durable job, verifies the new snapshot, and only then switches the launch to it. The previous run is archived to `history/<runId>` with its snapshot identity, so earlier reviewed work stays auditable.
- **Drift** is surfaced before review and approval: a Drive file changed since the snapshot shows the affected path, and the launch is marked stale until you refresh. Approval is never granted against content that changed underneath it.
- **Reconnect** replaces a connection in place: the new grant is verified, a superseded connection is deleted instead of orphaned, and the drift notice clears after a successful refresh.
- **Disconnect** requires the launch identity and a CSRF token, revokes the Google grant, deletes the local token, and returns you to the chooser. Disconnected cards are removed from the chooser and its count; their registry records, snapshots, and history remain on disk. Connecting the folder again through **Add a launch** creates a new launch, not a continuation of that hidden history.

## Demo scope for the bundled example

For a faster connection test, upload [`fictitious-ai/campaigns/pro500-lite/`](../fictitious-ai/campaigns/pro500-lite/README.md): a self-contained three-asset campaign with 18 shipped files (17 snapshot inputs). It uses website, email, and sales copy without video or PDF rendering. It runs in full-campaign mode for those three assets, not the 104-asset sample's four-asset Demo mode. Keep the folder structure and choose its manifest-containing root.

Demo scope (four assets of 104) applies only when the snapshot fingerprints as the **exact bundled 104-asset sample campaign**. Any other Drive folder always runs in full-campaign mode, and the release-scope panel states which applies before you start. Demo scope never changes an existing version’s recorded scope, and a demo release never counts as full-campaign approval.

To rehearse the Drive path with the bundled example, prepare a Drive-ready copy:

```sh
node scripts/prepare-drive-demo.mjs /tmp/pro500-drive-copy
```

That creates a private (`0600`) copy of the 104 deliverables and every referenced file, including `campaign.json` and the brand identity, and refuses to overwrite an existing destination. It performs no Drive access and no upload. Upload the copy to Drive, then connect it as a launch.

## Validate without live Google access

`npm test` exercises the entire path — authorization, PKCE, nonce and state checks, pagination, checksums, drift, refresh, disconnect, and the HTTP round trip — against an offline fake Google (`test/helpers/fake-drive.mjs`). No credentials, no network, and no paid calls are needed. The fake also serves deliberately broken variants: an ambiguous duplicate, a native document, an interrupted download, and a checksum mismatch.

To click through the same flow in a real browser without a Google account, run the walkthrough harness:

```sh
node scripts/demo-fake-google.mjs --fresh
```

It starts the real application against a local stand-in for Google's consent, token, revoke, and Drive endpoints, plus a local stand-in for the AI provider, so connect, snapshot, update, review, approve, drift, refresh, reconnect, and disconnect all work end to end with no credentials and no network egress. The harness prints the folder ID to paste into the chooser. It is a demo and validation tool only: the application, the tests, and the packaged example never load it, and it must never be used as a substitute for a real Google connection.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| “Google Drive is not configured on this server.” | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or a usable `GOOGLE_REDIRECT_URI` is missing. Set them and restart. |
| Consent screen rejects the redirect URI | The URI registered in the Google Cloud client does not match `GOOGLE_REDIRECT_URI` exactly, including port and path. |
| “Google authorization expired or was revoked.” | The grant was revoked, the refresh token expired, or the consent screen test-user list changed. Connect again. |
| “Enter a valid Google Drive folder ID or folder URL.” | The value is neither a folder ID nor a folder URL. Copy the URL from the browser address bar while the folder is open. |
| Snapshot reports ambiguous files | Two entries share a name in the same folder. Remove or rename one in Drive, then refresh. |
| Snapshot reports missing or inaccessible references | The manifest was readable, but referenced paths could not be resolved. The error reports the total unresolved count, up to five paths, the first missing path component, and up to five neighboring names. Check the selected root, exact filenames/extensions, completed uploads, and access permissions. Absence and lack of access cannot be distinguished from the Drive listing alone. No snapshot is committed. |
| Snapshot reports unsupported native documents | The campaign references a Google Docs/Slides/Sheets file or shortcut. Supply an exported/uploaded representation and update `campaign.json`, or accept the blocker. |
| A file exceeds the snapshot limit | Split or replace the file; single files above 250 MB and snapshots above 1 GB are refused. |
| The card shows drift after a refresh | A Drive file changed after the snapshot. Review the reported paths, then refresh again to record the new state. |
| “Another launch is busy.” | One campaign update runs at a time per workspace. Wait for the named operation to finish. |
| The launch does not appear on another machine | Launches, tokens, and snapshots are machine-local private state. Connect Drive on each machine that should have a launch. |

## Privacy and revocation

- The client secret, access token, and refresh token never reach the browser bundle, campaign files, or version control.
- Local token files are `0600` inside `0700` directories; the workspace registry is written atomically.
- Disconnect revokes the grant at Google and removes the local token. For a complete removal, disconnect each Drive launch and then delete the application data directory, or restore Drive access from your Google account’s third-party access page.
- A Drive launch grants no permission to upload, publish, share, or change campaign facts. Publishing stays with people, exactly as it does for local campaigns.
