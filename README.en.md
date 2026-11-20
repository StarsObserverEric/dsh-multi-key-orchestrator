# Multi-Key Orchestrator

[简体中文](README.md) · **English**

Spread one conversation's requests across the several API keys you already configured for a provider, so all of their quotas get used instead of leaning on the single key in your settings.

A DSH plugin. It does not patch the Harness, does not replace a model adapter, and does not change your requests — it only decides which of your own keys carries each one. Chinese name: **多密钥分流指挥家**.

---

## What it does

**Three keys, and only one of them ever works.** You configured several keys for the same provider, each with its own quota. To actually use them, you have to wait for one to run dry, open settings, switch keys by hand, and do it again next week.

**You want more subagents, upstream says no.** The provider caps concurrency, so firing several at once earns a 429 — even though you are paying for other keys that are sitting completely idle.

**Pooling only ever kicked in for subagents.** Even with several keys configured, a single conversation still burned through one key, because nothing rotated between them mid-conversation.

This plugin fills that gap: **every request in a conversation is handed to whichever key is currently the least busy.**

- Consecutive requests inside the same conversation land on different keys; you do not have to spawn subagents before the other keys see any traffic.
- Concurrent requests go to the key holding the fewest leases.
- Keys that are out of quota, cooling down after a rate limit, or switched off are excluded automatically.

---

## What else it gives you

### 1. Concurrency caps at three levels, enforced for you

The same three knobs exist for **any provider, any model, any key** — nothing is hard-coded to one platform:

| Level | What it limits |
|---|---|
| Provider | how many requests may be in flight across every model and key of that provider |
| Model | how many requests may be in flight for that one model |
| Individual API key | how many requests that one key may hold for that one model |

The plugin queues against those caps instead of overshooting them and collecting 429s: a request that would exceed a cap waits inside the plugin and resumes as soon as a slot frees. You choose the numbers; the plugin assumes nothing about any platform's limits.

**The main conversation always keeps a slot.** Each model's total can reserve slots exclusively for the main conversation (one by default). No amount of subagent traffic can take that slot, so the conversation you are sitting in never starves.

### 2. Lend the reserve while the main conversation is idle

A reserve costs subagents capacity all the time. If you would rather let them run at full width whenever you are not typing, turn on **Lend the reserved slot to subagents while the main process is idle**: after the main conversation has been idle briefly, the reserve is lent out; the moment it issues a request, the reserve is taken back.

### 3. A request that hits 429 recovers on its own

- A request queued inside the pool is released automatically as soon as any key frees a slot — you never re-send it by hand.
- A request rate-limited upstream (429) is not handed straight back: the plugin cools that key briefly and retries on another.
- A request cut off by a 429 *after* it already streamed some text is run again from the start (the partial output is discarded and the answer is regenerated), which the layer above sees as an ordinary retry.

The boundary: recovery is bounded by a retry budget (20 attempts and 30 minutes of waiting by default). Once that is spent the error surfaces normally instead of retrying forever — infinite retrying only leaves a spinner on screen.

---

## Install

Requires DSH Desktop.

**From GitHub**

```sh
dsh plugin --profile desktop add github:StarsObserverEric/dsh-multi-key-orchestrator
```

**From npm**

```sh
dsh plugin --profile desktop add @stars_observer_eric/dsh-multi-key-orchestrator
```

**From a local directory**

```sh
dsh plugin --profile desktop add /path/to/dsh-multi-key-orchestrator
```

Then **quit DSH completely and start it again**. The host half is loaded at process start; hot-reloading it does nothing.

Uninstall:

```sh
dsh plugin --profile desktop remove @stars_observer_eric/dsh-multi-key-orchestrator
```

Turning the plugin off never touches your keys or your model configuration; it just returns DSH to its normal single-key behaviour.

---

## Using it

### Where it lives

The navigation icon column on the left, one row **below Context Insights**, named **Multi-Key Orchestrator**. Clicking it opens the full-page panel. There is no other entry point and no floating window.

### Top of the page

| Control | Meaning |
|---|---|
| Master switch | off = the plugin steps aside entirely and every request uses DSH's native single-key path; your configuration is kept |
| Overlay | Whether the live request window is shown in the bottom-right corner. On by default; hiding it keeps every setting |
| Expand all / Collapse all | open or close every provider at once |
| Refresh all balances | query every key's balance right now (otherwise refreshed in the background) |
| Pending bar | appears when you have unsaved edits: `N pending changes` with **Apply** / **Discard** |

**Edits only take effect after Apply.** Typing in a field changes a local draft only; nothing is sent and nothing is saved until you press Apply.

### Inside a provider

Providers are collapsed by default; click the header to open one. Top to bottom:

**Provider concurrency** — the total in-flight limit for this provider. Empty or `0` means unlimited.

**API keys** — every key belonging to this provider.

- Each row shows: the mask (always dots), where the key came from, the provider-side account id (an identifier, never the secret), state (healthy / cooling / exhausted / disabled), failure count, last success, an editable **note**, and an **enabled** checkbox.
- The key **adopted from your settings** is marked `from Settings` and always sits first. It cannot be removed or hidden — it is your own credential, and the plugin only borrows it.
- Only keys you added here have **Remove key**, which also deletes the credential the plugin stored for it.
- Every key has a **Test connection** button: one character in, one token out, and any output at all counts as connected. The result appears under the row (`connected in 123 ms` / `failed: reason`). The probe **holds a real concurrency slot** (waiting up to 8 s, then reporting "busy" without sending), so it can never push a key into a 429 and never steals the slot reserved for the main conversation.
- The **balance card** on the right shows remaining / limit, a bar, quota state, when it was last checked, when it will be checked next, the reset time to the second, and a manual refresh. If the provider exposes no quota endpoint, the card says why instead of inventing a number.
- The last row adds a key: a note plus a write-only password field that clears on submit; afterwards the key is only ever shown as dots.

**Models** — one row per model this provider declares (read from your DSH settings).

- **total** — the in-flight limit for this model.
- **Link total to per-API caps** — when checked, `total` greys out and equals the sum of the per-key caps, with the arithmetic printed underneath (`total = 3 + 3 + 2 = 8`). Uncheck it and `total` becomes editable.
- **Reserved for main** — how many of this model's slots are kept for the main conversation.
- **Lend the reserved slot…** — whether that reserve may be lent to subagents while the main conversation is idle.
- **Per-API caps** — one column per key: that key's own limit for this model. Empty or `0` means the default of 3.
- The line under the grid is live: main leases, subagent leases, capacity, and how many requests are waiting.

### Live overlay (floating window)

The small window in the bottom-right corner shows **every request in flight right now**, including requests from other conversations and from subagents:

- The top bar is the title row: a chevron, the name, and an `N in flight` counter. Click it to expand or collapse. The panel grows **down and to the right** with the top-left corner pinned, so the bar never moves out from under the pointer.
- **Drag the top bar** to move the window, like a Windows title bar. The position is remembered. When the app window is resized, maximised or restored, the overlay is pushed back inside the visible area instead of ending up off-screen.
- One row per request: **conversation › subagent**, main/sub, model, the key it went out on (your note), and how long it has been running. Sorted by model, then by key.
- The middle block summarises: one line per busy model (`in flight / total`), then every key of that model with `active / cap`; keys that are out of credit are marked ⛔ and excluded from the total.
- No backdrop blur is added: glass is the job of a Wallpaper Engine style plugin that styles the whole window frame, and two layers of blur fight each other.

Example:

```
─────────────────────────────────────────────
Live requests                       2 in flight
─────────────────────────────────────────────
ecnu-max 2/9
ZSQ:1/3   LB:1/3   default:0/3⛔
─────────────────────────────────────────────
telegram-with-auto-replier › collect   main  ecnu-max  ZSQ   12s
this conversation                       sub  ecnu-max  LB     3s
```

### Bottom of the page

- **Diagnostics** — how requests are correlated with sessions, a recent-activity log (every acquire, release and cooldown), and a self-test that exercises the caps and the queue with simulated traffic without sending a single real request.
- **Rolling back** — three ways to stop: flip the switch, disable the plugin on the Plugins page, or uninstall. The native request path was never modified, so nothing else needs undoing.

---

### 4. An exhausted key steps aside — and comes back on its own

- After any failed request the plugin re-reads that key's balance (at most once per 10 s per key) instead of trusting the wording of the error: providers answer in English, in Chinese, with a code, or with nothing at all.
- Balance at zero → the key leaves the rotation immediately and **its slots are subtracted from the pool total** (three keys of 3 → 9, one spent → 6). The surplus requests queue behind the healthy keys instead of hammering the dead one.
- A parked key is re-checked every 60–180 s and rejoins the rotation by itself once its balance is back; the total follows it up again.
- The panel shows the state ("balance spent") and the floating window marks it with ⛔.

The boundary: this is a *balance* decision, not a *rate-limit* decision. A provider-side 168-hour window that the balance endpoint cannot see is still handled by 429 classification plus a cooldown.

### 5. The same key pasted twice counts once

A key taken from Settings and the same key pasted in the panel are one account as far as the provider is concerned, so they are merged into one scheduling unit by secret fingerprint. Three entries never advertise nine slots (which would guarantee 429s). After merging, the meaningful note wins (`default` + `LB` → `LB`), so the panel never shows two "default" rows.

### 6. Re-issuing the Settings key is noticed immediately

When the key in Settings is replaced, the plugin re-reads the credential, drops that key's cached balance and its parked state, and rebuilds the pools — the panel shows the new account, not the ghost of the old one.

### 7. A key without its own cap is not "unlimited"

A key with no per-key cap now contributes, and is limited to, the default **3**. It used to mean "no limit", which let a single key eat the whole pool — one of the roots of "three keys configured, still 429".


---

## Practical advice

1. **Give one provider at least two keys.** With a single key there is nothing to distribute, so the plugin stays out of the way and behaviour is unchanged.
2. **Fill in the caps you actually know.** The plugin never guesses a platform's limits: set them too high and upstream will rate-limit you, too low and you hold yourself back. A common start is one key's real concurrency per column and the linked total.
3. **Do not reserve zero slots** unless you are sure the main conversation never needs priority.
4. **Balances are not real-time.** They refresh on an interval and the card states when it was last checked and whether the number is cached; press refresh to force one.
5. **Notes are for you only.** They are never sent to the provider. Naming keys after their accounts is the easiest way to keep track of several keys under one person.
6. **Deleting a key in DSH settings will not break the plugin** — it re-reads the configuration and reports the missing credential.

---

## How it works

For anyone extending or debugging it.

**Where it hooks in.** The plugin does not register a model adapter (registering over an existing route is rejected). Instead it works on three seams that already exist:

- `llm/stream` — every model request passes through. The plugin takes a lease, picks a key, calls downstream, and records the outcome here.
- `llm-pi-ai/request-headers` — the synchronous seam just before headers go out. The plugin swaps `authorization` / `x-api-key` for the chosen key's real secret. The request body is frozen, so it only ever swaps credentials — never the model, never the content.
- `agent/request-error` — the seam before an error is handed upward. On a mid-stream rate limit the plugin takes ownership and asks for one retry.

**Scheduling.** One pool per provider + model, holding that provider's keys. Selection order:

```
fewest active leases → rotation cursor → health → most recent success
```

Leases first keeps concurrency even; the rotation cursor second keeps **sequential** requests moving between keys (without it a single conversation would keep hitting the same key); health and recency only break the remaining ties. Cooling, exhausted and disabled keys are excluded outright.

**Leases.** Taking a key creates a lease; the request returns it in `finally` — including when it throws — so a crashed request can never hold a slot forever.

**Two lanes.** `main` is the conversation you are in, `child` is subagents. Child capacity is the total minus the reserve, and the reserve can be lent out when the main lane is idle.

**Gates.** A provider-wide gate is shared across that provider's models, the pool gate covers the model, and a per-key gate covers each column — all three apply at once.

**Quota gate.** When a provider exposes a quota endpoint the plugin polls it and temporarily excludes keys at zero, so an empty account never gets picked only to be rate-limited. Polling is a read-only account call and spends nothing. Providers without such an endpoint simply show no balance; everything else still works.

**State.** The switch, caps, key list and notes live in the plugin's own state file (`.state/state.json` inside the plugin directory, mode 0600). Your profile configuration is never rewritten, and secrets go to DSH's credential service — the plugin's file only holds reference names.

**Routes.** Four local routes (`status`, `config`, `probe`, `selftest`), each behind two gates: the host session decides first (`ctx.connection.requestRejection` — the Host/Origin fence plus browser authentication), then the TCP peer must be this machine. A missing connection, or a missing authentication service, is a refusal rather than a pass.

---

## FAQ

**I configured several keys but only one appears.**
The panel shows the key adopted from your settings (marked `from Settings`) plus the keys you added here (`added here`). If a key you configured elsewhere is missing, check that it belongs to the same provider.

**Why is the balance empty?**
That provider exposes no quota endpoint, or the lookup failed — the card states which. A missing balance never affects routing.

**I changed a number and nothing happened.**
You did not press Apply. Every edit is a draft until then.

**Will I still see 429s?**
Not inside the limits you set; you can still hit them if your caps exceed what the account allows, or if several DSH windows share one account. When it happens the plugin cools that key and moves on.

---

## License

MIT.
