# WhatsApp microservice

Node.js 24, with no third-party runtime dependencies. Calls Meta's WhatsApp
Business Cloud API directly. Each organization has a server-configured sender,
access token, API key, and allowed templates. Callers cannot choose another sender
or pass arbitrary Meta payloads.

This first milestone supports approved templates with positional **text body
parameters** only. Headers, buttons, media, named Meta parameters, free-form chat,
scheduling, bulk sending, and organization onboarding are future additions.

## Local setup

Run inside this folder:

```sh
cp .env.example .env
cp examples/organizations.json config.local.json
npm test
```

Edit `.env` with real Meta credentials and a supported Graph API version selected
from your Meta app dashboard. Replace the phone number IDs in
`config.local.json` with Meta **phone number IDs**, not telephone numbers.
Remove the example organization you are not configuring. Each referenced secret
must be present. Generate a different internal API key for each organization:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Configure actual approved template names, exact language codes, and your local
parameter names in order. Example templates are illustrative; they are not created
or approved by this service. For example, a library template could read:

> Hello {{1}}, your subscription at {{2}} renews on {{3}}.

The body parameter list for that template is
`["customer_name", "library_name", "renewal_date"]`.

```sh
npm start
```

Startup fails if required configuration is absent. Tests use mocked Meta responses;
they do not require credentials and never send a real WhatsApp message.

## Send a renewal reminder

Your library backend calls this endpoint. Keep the organization API key in your
backend; never embed it in a browser or mobile app.

```sh
curl http://localhost:8080/v1/organizations/library-demo/messages/template \
  -H "Authorization: Bearer ${LIBRARY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "919876543210",
    "template": "subscription_renewal",
    "recipientOptIn": true,
    "parameters": {
      "customer_name": "Asha",
      "library_name": "Gramin Library",
      "renewal_date": "10 November 2026"
    }
  }'
```

Set `LIBRARY_API_KEY` in the calling shell first; npm loads `.env` only for the
service process. Use a real, opted-in test recipient when testing with Meta.
The phone number contains country code and digits without `+`.

`recipientOptIn: true` is an assertion by the trusted calling service. That service
must collect, store, and verify consent and honor opt-outs. This API does not keep
a consent registry. Proactive subscription/receipt notifications use Meta-approved
templates; Meta's approval and messaging rules still apply.

Successful response: HTTP `202` with
`{"messageId":"wamid.…","status":"accepted","requestId":"…"}`.
Acceptance is not delivery; delivery updates arrive through webhooks.

For restaurant receipts, use `/v1/organizations/restaurant-demo/messages/template`
with that organization's key, template `purchase_receipt`, and fields
`customer_name`, `restaurant_name`, `order_number`, and `total`.

## HTTP endpoints

| Method | Path | Authentication |
| --- | --- | --- |
| GET | `/healthz` | Public process health; does not test Meta credentials |
| POST | `/v1/organizations/{id}/messages/template` | Organization Bearer API key |
| GET | `/webhooks/whatsapp` | Meta verify-token handshake |
| POST | `/webhooks/whatsapp` | Raw-body HMAC using Meta app secret |

Errors include an error code and request ID. Common statuses are `400` for invalid
input, `401` for invalid credentials/signature, `413` for bodies over 64 KiB,
`415` for non-JSON bodies, and `502` for Meta rejection or an unknown send outcome.
Meta requests time out after 10 seconds. There are no automatic retries or
idempotency guarantees. A timeout may occur after Meta accepts a message: blindly
retrying could send duplicates. Durable deduplication and a queue are required
before adding reliable automatic retries or production bulk sending.

## Meta setup

1. Create/configure a Meta business app with WhatsApp, a WhatsApp Business Account,
   and a registered business phone number (or use Meta's test setup initially).
2. Obtain an access token with the appropriate WhatsApp messaging permissions and
   access to the configured phone number. Use a managed system-user token for
   deployment; rotate credentials according to your account requirements.
3. Create and get approval for your notification templates and configure their
   exact names/languages here. Test-mode senders have recipient restrictions.
4. Set the webhook callback to `https://YOUR_SERVICE/webhooks/whatsapp` and the
   verify token to `META_WEBHOOK_VERIFY_TOKEN`. Subscribe to the `messages` field
   and subscribe the app to the relevant WhatsApp Business Account(s).
5. `META_APP_SECRET` is the app secret used to verify POST signatures; it is
   different from both the access token and the chosen webhook verify token.

This version uses one Meta app secret, so configured senders must belong to the
same Meta app integration. Separate WABAs/numbers per organization are supported;
the integration must have authorization to access them. Sending on behalf of other
businesses may require Meta's business onboarding and permissions approval.

Signed status callbacks produce structured logs containing message ID, sender
phone number ID, status, and error codes. Credentials, recipient numbers, message
bodies, and raw webhook payloads are not logged. Webhooks can be repeated or arrive
out of order. No delivery-status database, callback forwarding, or inbound-chat
processing exists yet; inbound events are acknowledged without storage.

## Cloud Run later

The container listens on `0.0.0.0:$PORT`, defaults to 8080, runs as a non-root user,
and shuts down on SIGTERM. No local state is needed for sending.

```sh
docker build -t gramin-whatsapp .
docker run --rm -p 8080:8080 --env-file .env \
  -v "$PWD/config.local.json:/app/config.local.json:ro" gramin-whatsapp
```

The Docker image includes only source and package metadata. For Cloud Run, inject
`ORGANIZATIONS_JSON` containing the organization map and each referenced credential
through Secret Manager, along with `META_APP_SECRET` and
`META_WEBHOOK_VERIFY_TOKEN`. `ORGANIZATIONS_JSON` takes precedence over the local
file. Set `META_GRAPH_VERSION` as a normal environment variable. Never include
`.env` or organization secrets in the image.

Meta needs a publicly reachable webhook. If this service hosts both webhooks and
send routes on Cloud Run, enable public invocation at Cloud Run and rely on the
application's organization authentication for sending and signatures for callbacks.
For IAM-only internal sends later, split the public webhook receiver into a
separate service. Add durable message/consent storage, deduplication, rate limits,
and delivery-event processing before a customer production rollout.

References: [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/),
[Meta webhook setup](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/),
[Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract).
