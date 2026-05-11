# FeedFerret Internal API

The Internal API enables external systems (SaaS portals, billing providers, Stripe webhooks, etc.) to manage users without embedding SaaS-specific logic in the OSS codebase.

## Authentication

All `/api/internal/*` endpoints require a Bearer token that matches the `INTERNAL_API_KEY` environment variable.

```
Authorization: Bearer <INTERNAL_API_KEY>
```

If `INTERNAL_API_KEY` is not set, all internal API calls return `401 Unauthorized`.

### Generating a key

```bash
openssl rand -base64 32
```

Set the result in your environment:

```env
INTERNAL_API_KEY="generated-key-here"
```

> **Security:** Never expose `INTERNAL_API_KEY` to client-side code or commit it to version control. Rotate it immediately if compromised.

---

## Endpoints

### `POST /api/internal/provision-user`

Create a new user account. Intended to be called from your SaaS portal after a successful Stripe checkout or subscription activation.

**Auth:** `Authorization: Bearer <INTERNAL_API_KEY>`

**Request body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | ✅ | User's email address |
| `name` | string | ❌ | Display name |

```json
{
  "email": "alice@example.com",
  "name": "Alice"
}
```

**Response `201 Created`:**

```json
{
  "userId": "clxyz123abc",
  "email": "alice@example.com",
  "created": true
}
```

**Response `409 Conflict`** — user already exists:

```json
{
  "error": "User already exists",
  "userId": "clxyz123abc"
}
```

**Response `400 Bad Request`** — missing email:

```json
{ "error": "email is required" }
```

**Response `401 Unauthorized`** — bad or missing token:

```json
{ "error": "Unauthorized" }
```

**Notes:**
- The provisioned user has no password. They sign in using the **magic link** (passwordless email) option.
- If mail is enabled (`mailServiceEnabled = true` in GlobalSettings), a welcome email is sent automatically.
- The user is created with `role = "USER"` and `isActive = true`.
- Registration settings (`registrationsEnabled`) do **not** affect this endpoint.

---

### `POST /api/internal/suspend-user`

Suspend (deactivate) a user account. The user immediately loses access on their next session refresh or login attempt.

**Auth:** `Authorization: Bearer <INTERNAL_API_KEY>`

**Request body (JSON):** Provide either `email` or `userId`:

```json
{ "email": "alice@example.com" }
```

```json
{ "userId": "clxyz123abc" }
```

**Response `200 OK`:**

```json
{
  "suspended": true,
  "userId": "clxyz123abc",
  "email": "alice@example.com"
}
```

If the user was already suspended:

```json
{
  "suspended": true,
  "userId": "clxyz123abc",
  "email": "alice@example.com",
  "alreadySuspended": true
}
```

**Response `404 Not Found`:**

```json
{ "error": "User not found" }
```

**Notes:**
- Suspension sets `isActive = false` on the user record.
- Active sessions are invalidated on the next JWT refresh (within minutes, depending on session config).
- New login attempts from suspended users are blocked immediately.
- Suspended users can be reactivated in **Server Management → Users** by an admin, or you can add a `/api/internal/reactivate-user` route following the same pattern.

---

## Integration Example: Stripe Webhook

```typescript
// pages/api/stripe-webhook.ts (or your SaaS backend)
import Stripe from "stripe";

const FEEDFERRET_URL = process.env.FEEDFERRET_URL!;
const FEEDFERRET_API_KEY = process.env.INTERNAL_API_KEY!;

async function provisionUser(email: string, name: string) {
  const res = await fetch(`${FEEDFERRET_URL}/api/internal/provision-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FEEDFERRET_API_KEY}`,
    },
    body: JSON.stringify({ email, name }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Provisioning failed: ${await res.text()}`);
  }
  return res.json();
}

async function suspendUser(email: string) {
  const res = await fetch(`${FEEDFERRET_URL}/api/internal/suspend-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FEEDFERRET_API_KEY}`,
    },
    body: JSON.stringify({ email }),
  });
  return res.json();
}

// Example: handle Stripe events
export async function handleStripeWebhook(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await provisionUser(
        session.customer_details!.email!,
        session.customer_details!.name || "",
      );
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customer = await stripe.customers.retrieve(sub.customer as string) as Stripe.Customer;
      await suspendUser(customer.email!);
      break;
    }
  }
}
```

---

## Error Reference

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing or invalid body |
| `401` | Unauthorized — bad or missing `INTERNAL_API_KEY` |
| `404` | User not found (suspend only) |
| `409` | Conflict — user already exists (provision only) |
| `500` | Internal server error |
