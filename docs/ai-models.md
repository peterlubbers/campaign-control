# AI model catalog

Added October 7, 2026, after the hackathon. Catalog `2026-10-07.1` is maintained in `lib/model-catalog.mjs`. These are explicit API IDs verified in official documentation, not IDs inferred from friendly names. Documentation checks are not proof of account access or a successful live integration.

| Picker name | Version / concrete API ID | Standard input / output USD per million tokens | Official source |
| --- | --- | --- | --- |
| Sol | GPT-6.1 Sol · `gpt-6.1-sol` | $2 / $10 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-6.1-sol) |
| Astra | GPT-6 Astra · `gpt-6-astra` | $10 / $50 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-astra) |
| Luna | GPT-6 Luna · `gpt-6-luna` | $0.10 / $0.50 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-luna) |
| Opus | Claude Opus 5.5 · `claude-opus-5-5` | $4 / $20 | [Anthropic](https://platform.claude.com/docs/en/models/opus-5-5/overview) |
| Fable | Claude Fable 5.1 · `claude-fable-5-1` | $10 / $50 | [Anthropic](https://platform.claude.com/docs/en/models/fable-5-1/overview) |
| Haiku | Claude Haiku 5.5 · `claude-haiku-5-5` | $0.10 / $0.50 up to 100,000 input tokens; $0.50 / $2.50 above that | [Anthropic](https://platform.claude.com/docs/en/models/haiku-5-5/overview) |

Prices were checked October 7, 2026. These are standard uncached token prices, not measured run costs. OpenAI long-context premiums, caching, region and service tiers can change applicable rates. Anthropic prompt length and caching can change applicable rates. Current request limits and batching remain unchanged. Luna costs less than Sol, which costs less than Astra; Haiku costs less than Opus, which costs less than Fable at the documented standard rates. This does not establish equivalent quality, latency, or operational savings.

## Adapter compatibility and aliases

All three OpenAI pages explicitly list Responses API and structured-output support. All three Anthropic IDs appear in the official [structured-output support list](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), using `output_config.format`. The existing adapters send no unsupported sampling controls and ignore thinking blocks when extracting structured text.

The OpenAI model pages list these exact IDs as available snapshots. No Astra/Sol/Luna `-latest` ID is fabricated. OpenAI documents [GPT-5 Chat’s `gpt-5-chat-latest`](https://developers.openai.com/api/docs/models/gpt-5-chat-latest), but its page does not supply a separate concrete snapshot target; it is not a picker choice.

Anthropic’s [ID/versioning contract](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) says IDs from generation 4.6 onward are pinned snapshots despite lacking dates. A page’s “Latest” lifecycle label is not a `-latest` API alias. Infrastructure changes can still affect behavior, even for pinned model weights.

## Maintenance

Mappings do **not** refresh themselves. For a catalog update:

1. Review official model specifications, API compatibility, pricing and deprecation notices.
2. Record literal IDs, factual descriptions, capabilities, sources, and actual verification date. If adding a moving choice, first establish a documented concrete snapshot mapping; never reuse a floating alias throughout a run.
3. Bump the catalog version and update contract tests and this page. Run mocked adapter/UI/engine tests, then `npm test`. Live access must be separately authorized and reported.
4. Ship as a tested app release. Do not rewrite configuration selections or historical runs. A removed saved choice stays visible and requires an explicit in-app replacement for new runs. Existing pinned runs retain their exact ID and catalog version.

## Local verification without model requests

1. Restart the app after installing this code, open **AI settings**, and inspect the saved choice and credential status.
2. Pick another provider and a model. Confirm the API ID and description. **Cancel**, reopen, and verify the saved choice did not change.
3. Pick a model again and **Save selection**. Reopen settings and confirm the saved choice. Stop/restart the server with the same `--config` argument, if used, then refresh; the choice must remain.
4. With no credential for the selected provider, confirm saving is allowed and **Update campaign** is disabled. Do not start an update or run `check-ai.mjs` just to verify selection persistence; those operations can incur charges.

Automated tests use temporary campaigns and synthetic credentials/transports. They check processing locks and save/start races, new-run pinning before requests, corrections/rechecks/restarts, catalog changes, failed writes, and legacy download integrity. They do not establish live model quality or current account permissions.
