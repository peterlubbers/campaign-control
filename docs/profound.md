# Live reasoning and optional Profound evidence

Authored during the October 3, 2026 build. No prior rehearsal assets or implementation were used.

Campaign Control revises campaign content and its publisher metadata together across 104 deliverables in 11 channels. Video includes the prelaunch script and complete YouTube metadata handoff. The output is reviewable local material for a human publisher. It does not require a published YouTube URL and does not update YouTube. A Profound optimizer that requires an existing URL is therefore outside this build's core path.

## Live proposal and independent audit

The server defaults to OpenAI's Responses API with strict structured JSON output; Anthropic's Messages API is an explicitly selectable alternative. A proposal request sees original facts, confirmed target facts, and actual campaign Markdown. A separate audit request checks candidates independently. Both reject missing, duplicate, or unexpected asset IDs, malformed responses, incomplete generations, refusals, and contradictory statuses. Unsupported commercial claims remain blocked for a human decision. There is no prerecorded model response, automatic provider fallback, or deterministic fallback presented as AI.

Select the provider/model in **AI settings** and save. The config file is internal persistence, not the normal selection workflow. `LAUNCH_AI_PROVIDER`, `OPENAI_MODEL`, and `ANTHROPIC_MODEL` are ignored with a safe names-only notice. Credentials stay only in the server environment and never belong in browser bundles, configuration files, source control, or chat. [Configuration details](configuration.md).

| Provider | Required server credential | In-app choices |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | Sol, Astra, Luna |
| Anthropic | `ANTHROPIC_API_KEY` | Opus, Fable, Haiku |

An unknown provider fails configuration. Credential presence for both providers is shown as booleans; only the executing provider's credential enters a model request. A missing credential does not switch providers. Saving or selecting never sends a request. Successfully validated requests verify access for that exact provider/model in the current server session; restart clears this verification status, not run provenance. OpenAI requests use `store:false`, bearer authentication, and `text.format` with a strict JSON schema. Responses are read by typed output items, allowing reasoning items before assistant text; a refusal, error, incomplete response, or missing model/usage evidence fails the request. `store:false` is a request storage setting, not a blanket claim about provider data retention.

Defaults are eight assets per batch, two concurrent requests, and a 90-second timeout. Each proposal request caps output at 12,000 tokens; each audit request caps output at 6,000 tokens. For OpenAI, reasoning tokens share the output limit. Confirmed temporary rate-limit or overload rejections allow at most two retries, honor Retry-After, and wait no more than 30 seconds in total within the request deadline. Quota, spend-limit, authentication, unknown HTTP failures, and network failures do not auto-retry. Progress reports retry waits, and successful request records include attempt counts. Usage, selected provider, returned model, and provider request IDs are retained as execution evidence. Credential presence is distinct from a successfully verified live request. OpenAI and Anthropic were subsequently exercised in live hackathon runs. Automated adapter tests still use isolated synthetic transports; they do not make real API calls. See the README for observed processing times.

Body copy and publisher metadata are checked independently, with metadata fields preserved, including supported multiline values. Video Markdown is treated as a whole: scene and narration copy, YouTube title, description, tags, chapters, and publisher instructions are revised together. The text audit cannot certify pixels, audio, or timing; representation checks and human playback remain necessary.

References: OpenAI [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and [Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create); Anthropic [Messages API](https://platform.claude.com/docs/en/api/messages/create) and [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

## Assigned buyer-question evidence

The local hackathon campaign supplied manually observed prompts from the organizer-assigned Mixpanel dataset. The public package omits these account-specific observations and its `marketEvidencePath`; you may configure evidence you have permission to use. These are buyer-question context for consistent answers across campaign copy and metadata; they are not Fictitious AI facts, demand estimates, or proof of competitor claims. The bounded evidence loader validates provenance and content and binds the raw evidence hash to the run. See [Mixpanel use](mixpanel-use.md) for the exact mapping and limitations. This manual browser observation does not establish an API connection.

## Optional, read-only citation adapter

The adapter is implemented against the official [Profound OpenAPI specification](https://api.tryprofound.com/openapi.json), inspected during today's build. Live account access is **unverified until a real request succeeds**. A logged-in browser is not an API credential.

The adapter requires server-only `PROFOUND_API_KEY`, `PROFOUND_ORGANIZATION_ID`, `PROFOUND_CATEGORY_ID`, and `PROFOUND_DATASET_CONFIRMED=assigned-hackathon`. The organization/category must be the organizer-assigned data, not another customer account. None of these values belong in source control or browser bundles. Do not paste credentials into chat.

1. `GET /v1/org/categories?organization_ids=…` verifies the selected category belongs to the selected organization. The organization filter is mandatory in this adapter.
2. `POST /v1/reports/citations` runs a read-only analytics query for that category and an explicit date range. It requests URL dimensions and count/citation-share metrics. Authentication uses the documented `X-API-Key` header.
3. The result retains query, retrieval time, report hash, reported total rows, returned rows, and a truncation flag. The default limit is 100; results are a ranked slice, not a claim of exhaustive account coverage.

Profound's [Citation Pages guidance](https://help.tryprofound.com/articles/9456412811-citation-pages) describes using cited URLs and citation metrics to prioritize content work. Campaign Control can use that evidence to prioritize launch surfaces. A YouTube URL in these results identifies a cited video; it grants no edit rights and does not establish that the supplied dataset describes fictional Fictitious AI.

Recommendation: keep this optional evidence alongside the human review packet. **Confidence: High** for the integration design, **unverified** for live access until configured. Expected impact: focus review effort on surfaces with observed citation exposure. Tradeoff: the event dataset is an external prioritization example, and citation counts alone cannot prove conversion lift or revenue. No remote publishing, monitoring loop, or YouTube write connector is included.

## Diagnose an AI access failure

Run `node scripts/check-ai.mjs` in the same Terminal session that supplies the server credential. It makes a small structured-output request using the selected provider/model, changes no campaign files, and prints only safe error categories and guidance. It never prints the key or the raw provider error body. If the server occupies that terminal, stop it with Ctrl+C first; the exported key remains in that shell. Restart with `npm start` afterward to load code changes.

HTTP 429 alone does not distinguish exhausted quota from temporary throttling. The adapter uses allowlisted `error.code` / `error.type` values, never the provider message. Credits and account limits require the account owner; editing campaign copy does not fix quota. A failed run keeps its brief, scope, and existing outputs. Returning to the brief preserves Demo mode when the failed run was scoped.

References: [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes) and [rate-limit recovery](https://developers.openai.com/api/docs/guides/rate-limits).
