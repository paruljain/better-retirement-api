# Product update email setup

Better Retirement sends product announcements through Azure Communication Services Email. The sender is configured as `Better Retirement <no-reply@better-retirement.com>`. Users can unsubscribe from any announcement and unsubscribe or re-subscribe from the account menu.

## Azure resources

1. Create an Azure Email Communication Service resource.
2. Add and verify the custom domain `better-retirement.com`.
3. Add the DNS records Azure provides for domain verification, SPF, and DKIM.
4. Add the `no-reply` MailFrom sender and set its display name to `Better Retirement` in Azure. The SDK controls the address, while Azure's MailFrom configuration controls the display name.
5. Link the email domain to the Azure Communication Services resource used by the Function App.
6. Before sending at launch scale, request an email quota increase for the verified custom domain.

Create an Event Grid subscription for `Microsoft.Communication.EmailDeliveryReportReceived`. Point it to the `email-delivery-events` HTTP function shown in the Function App portal. This function uses function-level authorization; use the function URL supplied by Azure, including its key.

## Function App configuration

Configure these application settings in the backend Function App and in `local.settings.json` for local testing:

```text
AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING=<Azure Communication Services connection string>
EMAIL_SENDER_ADDRESS=no-reply@better-retirement.com
EMAIL_REPLY_TO_ADDRESS=<a monitored Better Retirement address>
EMAIL_PUBLIC_API_BASE_URL=<public backend origin, without /api at the end>
EMAIL_POSTAL_ADDRESS=<optional postal address shown in every announcement>
EMAIL_UNSUBSCRIBE_SECRET=<a long random secret distinct from APP_JWT_SECRET>
EMAIL_SEND_INTERVAL_MS=2100
```

`EMAIL_SEND_INTERVAL_MS=2100` keeps the sender below the initial Azure limit of 30 send requests per minute. It can be reduced after Azure approves a higher quota.

Do not commit real settings, connection strings, secrets, or the business address in source control.

## Prepare and send a campaign

Write the subject and message in one Markdown file. Put `Subject: Your subject here` on the first line, followed by a blank line and the message. Supported body formatting includes headings beginning with `#` or `##`, bulleted lines beginning with `-`, bold text surrounded by `**`, and HTTPS links. See `docs/product-update-example.md` for a reusable starting point.

Previewing is the default and does not send email:

```powershell
npm run email:announcement -- --campaign august-product-update --file tmp/august-product-update.md
```

The preview prints the eligible audience count, exclusions, message, and a confirmation value. Recipient samples are masked.

Send a test only to an explicitly named address:

```powershell
npm run email:announcement -- --test --campaign august-product-update --file tmp/august-product-update.md --to test-recipient@example.com
```

After reviewing the delivered test, send to the eligible audience using the exact confirmation value printed by the latest preview:

```powershell
npm run email:announcement -- --send --campaign august-product-update --file tmp/august-product-update.md --confirm august-product-update:25:0123456789ab
```

Each recipient receives an individual message. The tool excludes unsubscribed and undeliverable addresses and rechecks each preference immediately before sending. It records campaign and recipient results in MongoDB and refuses to reuse a campaign ID for changed content. A completed campaign cannot be sent again. Failed recipients are skipped on a resumed run unless `--retry-failed` is explicitly supplied. A record left in `Sending` after an interrupted run is not retried automatically because Azure may already have accepted it. If the campaign process was interrupted, first verify that no sender process remains active, then repeat the send command with `--resume`.

The tool uses these MongoDB collections:

- `emailPreferences` for subscriptions and delivery eligibility
- `emailCampaigns` for campaign content, status, and totals
- `emailDeliveries` for per-recipient attempts and Azure message IDs

After a campaign, delivery events update delivered, bounced, suppressed, and spam-filtered statuses. Addresses with a delivery problem are excluded from later campaigns. An explicit re-subscription from the signed-in account restores delivery eligibility for a new attempt; another bounce blocks later campaigns again.
