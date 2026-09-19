# TikTok Ads Synthesis Taxonomy

The report generator classifies messages into these strategy groups:

- Creative Hooks and UGC Format
- Creative Testing and Iteration
- Media Buying and Scaling
- Offer, Landing Page, and Conversion
- Unit Economics and Profitability
- Creator and Agency Monetization
- Policy, Bans, and Compliance Risk

Use this file to keep category names aligned with your server language.

If a server uses custom jargon, update `scripts/synthesize-discord-export.mjs`:

1. Add keywords to `STRATEGY_RULES[].terms`.
2. Update `STRATEGY_RULES[].action` text for better action-plan outputs.
3. Add/remove entries in `MONETIZATION_TERMS` if needed.
