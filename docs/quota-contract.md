# ECNU quota endpoint — measured contract

Measured on 2026-11-11 against `GET https://chat.ecnu.edu.cn/open/api/v1/quota`
with a single user API key in `Authorization: Bearer <key>`.

> Note: the first attempt from Windows PowerShell 5.1 timed out because the
> default security protocol is TLS 1.0. Using TLS 1.2 (curl) succeeded, so the
> probe implementation must not rely on the ambient PowerShell/default HTTP
> stack of the host process — Node's `fetch` (undici) negotiates TLS 1.2/1.3 on
> its own and was confirmed working for the sibling `/models` route.

## Request

```
GET {baseURL}/quota
Authorization: Bearer <this key's own secret>
Accept: application/json
```

`baseURL` is the same one the provider is configured with
(`https://chat.ecnu.edu.cn/open/api/v1`), so the quota route is `baseURL + '/quota'`.

## Response 200 (real body, formatting only)

```json
{
  "provider_id": "chatecnu",
  "api_key_id": "key_5638",
  "unit": "credits",
  "windows": [
    {
      "type": "fixed_168h",
      "limit": 25000,
      "used": 11665.54902,
      "remaining": 13334.45098,
      "window_started_at": "2026-11-08T23:27:28+08:00",
      "reset_at": "2026-11-15T23:27:28+08:00",
      "source": "manual"
    }
  ],
  "resource_packs": [
    {
      "id": 437,
      "name": "学习支持",
      "total_credits": 5000,
      "used_credits": 5014.3329,
      "remaining_credits": 0,
      "expires_at": "2027-01-09T16:22:17.575073+00:00",
      "status": "exhausted"
    }
  ],
  "ops_console_url": "https://aiconsole.ecnu.edu.cn"
}
```

### Facts that shaped the implementation

| Fact | Consequence |
|---|---|
| `api_key_id` is present and per-key | Probes **must** run with each key's own secret; two keys on the same provider legitimately report different ids and different balances. `api_key_id` is an identifier, not a secret, and is surfaced as `quota.account.apiKeyId` for exactly this verification. |
| `windows[]` is a fixed 168 h (7 day) window with `limit` / `used` / `remaining` / `reset_at` | `reset_at` is what the original design called "the seven-day window"; it is reported to the panel, but an exhausted key is **re-probed every 30–60 min** rather than being parked until reset. |
| `resource_packs[]` may be `exhausted` while a window still has credit | The usable number is the **sum of positive remainders across windows and packs**, not any single field. |
| `used_credits` can exceed `total_credits` for a pack | Every remainder is clamped with `max(0, …)` before summing. |
| `unit` is `credits` | Displayed verbatim; never assumed to be a currency. |

## Normalisation applied by `quota.js`

```
remaining = Σ max(0, window.remaining)          + Σ max(0, pack.remaining_credits)
total     = Σ window.limit                      + Σ pack.total_credits
used      = Σ window.used                       + Σ pack.used_credits
unit      = body.unit ?? 'credits'
resetAt   = earliest future window.reset_at, else earliest future pack.expires_at
state     = remaining <= 0            ? 'exhausted'
          : remaining <= total * 0.15 ? 'low'
          :                            'ok'
account   = { providerId: body.provider_id, apiKeyId: body.api_key_id }
```

## Failure modes

| Situation | Handling |
|---|---|
| HTTP 401 / 403 from the quota route | `state: 'probe-failed'`, `error: 'quota-auth'`. The key is **not** removed from the pool; only the balance card shows the problem. |
| HTTP 404 | `state: 'unsupported'` — this provider has no quota route. The key stays poolable and the card says so. |
| Timeout / 5xx / network | `state: 'probe-failed'` with the previous numbers preserved and `stale: true`. Routing degrades to passive: the key stays eligible and is only parked by an observed 429. |
| Unparseable JSON | `state: 'probe-failed'`; a tolerant recursive scan for `remaining|left|balance|credit|quota|available` and `total|limit|max` is attempted first, so an upstream shape tweak does not immediately break routing. |
