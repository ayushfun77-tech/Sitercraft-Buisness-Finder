# SiteCraft Prospect AI

This app now uses Apify as the prospect search engine instead of Google Places directly.

## What it does

1. Search businesses by location and niche through Apify.
2. Rank high-review businesses with no website.
3. Let you paste a demo site link.
4. Generate a WhatsApp-ready outreach message.
5. Optionally send the lead plus message into your own automation webhook.

## Run it

```powershell
.\start.ps1
```

Then open [http://localhost:3000](http://localhost:3000).

## Config

- `APIFY_TOKEN` and `APIFY_ACTOR_ID` can be stored in `.env`
- `APIFY_RUN_URL` is also supported as a fallback if you prefer pasting a run URL instead
- `OUTREACH_WEBHOOK_URL` is optional and enables automated dispatch into your own flow

## Notes

- The UI can still work in demo mode without spending Apify credits.
- A real live search triggers a fresh Apify actor run, so use it when you are ready.
- `.env` is ignored by `.gitignore` so your token stays local.

## Sources used for the implementation

- Apify Actor run API: https://docs.apify.com/api/v2/actor-run-get
- Apify Dataset items API: https://docs.apify.com/api/v2/dataset-items-get
- Apify Run actor synchronously and get dataset items: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-get
