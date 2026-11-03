# Verification-only deployment

The service defaults to `WHATSAPP_MODE=webhook`. Sending is disabled. No Graph
version, organization JSON, phone number ID or access token is needed to start.
Existing sender code is retained for later.

Deploy the updated GitHub revision. In Cloud Run's **Edit & deploy new revision →
Containers → Variables & Secrets**, set:

| Name | Value |
| --- | --- |
| `WHATSAPP_MODE` | `webhook` (also the default) |
| `META_WEBHOOK_VERIFY_TOKEN` | A random secret you choose; use exactly the same value in Meta |

Use Secret Manager for the verify token. Remove any placeholder `META_APP_SECRET`
until you have a real value. Other old sending configuration is ignored. Keep
port 8080, public invocation, and ingress All. Deploy the revision.

Open `/healthz` on the service URL to confirm startup. Expect `{"status":"ok"}`.
Using the URL previously shown in your dashboard, Meta's callback URL is:

```text
https://whatsapp-175492738007.asia-south1.run.app/webhooks/whatsapp
```

Confirm the base URL against the Cloud Run service page; this document does not
confirm it is live. Enter the callback URL and matching verify token into Meta,
leave client certificate attachment off, and click **Verify and save**. GET
verification returns the exact plain-text challenge only when `hub.mode=subscribe`
and the token matches. Wrong tokens or missing challenges return 403.

Initially this is verification only. POST callbacks return 503 until you add the
real `META_APP_SECRET` and redeploy. This preserves signature verification rather
than accepting unsigned events. Subscribe to `messages` after configuring that
secret. Signed callbacks are then acknowledged and delivery statuses logged;
inbound messages are not stored. No sending occurs in webhook mode.

Later, explicitly set `WHATSAPP_MODE=messaging` and configure the full credentials
described in DEPLOY.md. Graph version and organization requirements in that guide
apply only to messaging mode. Token and payload contents are never logged.
