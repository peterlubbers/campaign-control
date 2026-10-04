# Market evidence and claim review

The hackathon demo used manually observed buyer-question context from the organizer-assigned Profound Mixpanel dataset. Mixpanel is a real product analytics company; Fictitious AI is fictional. Reference data cannot establish facts or performance for the fictional brand.

The public package omits those signed-in dataset records, URLs, prompt quotations and metrics. It runs without external evidence. To add your own permitted observations, place schema-valid JSON beneath the campaign’s `evidence/` directory and configure `marketEvidencePath` in `campaign.json`. See [configuration](configuration.md), [the validator](../lib/evidence.mjs) and [synthetic schema tests](../test/evidence.test.mjs).

## How context informs a revision

1. Load the evidence with its source, observation method, dates and limitations.
2. Find relevant passages and publisher fields in the existing campaign.
3. Compare them with the human-confirmed product change. Evidence never overrides product facts or authorizes a new feature or offer.
4. Propose revisions and independently audit the complete candidates.
5. Bind the evidence fingerprint, candidate files and product facts to human approval.

For example, [SAL-004](../fictitious-ai/campaigns/pro500/sources/sales/sal-004.md) promises that another reviewer can continue an analysis. Removing sharing requires revisiting that implied promise, not simply replacing the plan name and price. This is a semantic evaluation case, not an asset-specific exception.

Metadata travels with its parent deliverable. Unaffected educational content should remain unchanged. Evidence mappings show why content deserves review; they do not prove demand, visibility lift, time savings or revenue impact.

The optional Profound API adapter is separate from these manual observations and remains unverified against a live account. No remote publishing is implemented.
