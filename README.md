# Gramin microservices

Each microservice lives in its own folder and owns its source, configuration,
tests, documentation, and deployment files. Deploy services independently to
Google Cloud Run later; there is no shared runtime or root dependency install.

## Services

- [whatsapp](whatsapp/README.md): internal, organization-scoped API for sending
  customer notifications directly through Meta's WhatsApp Business Cloud API.

Library subscriptions and restaurant purchases belong to their respective domain
services. Those services decide when a notification is needed and call WhatsApp.
The WhatsApp service handles authentication, template validation, Meta requests,
and verification of delivery-status webhooks.

