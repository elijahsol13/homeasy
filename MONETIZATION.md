# HomEasy — Monetization Plan (draft)

> Status: research draft for owner review. Nothing here is implemented.
> Context: Siem Reap–only MVP, rentals ≥1 month, audience = independent
> tourists & expats. Distribution = Telegram bot + Mini App. Real estate
> market in Cambodia is relationship-driven; agents post on Facebook/Khmer24
> and close via Telegram/phone — we are an aggregator, not a brokerage.

## Guiding constraints

- Do not put paywalls in front of the core value (finding a rental). The moat
  is coverage + freshness + convenience, not listings themselves.
- Cambodia payment reality: locals/expats use ABA PayWay, Bakong, Wing;
  foreigners — Stripe cards, Wise, crypto. Telegram in-app payments are
  awkward; Mini App is a good surface for checkout links.
- Volume will be small at first. Prioritize revenue models that work at
  100–500 MAU, not models needing 10k+.

---

## Option ranking (recommended order)

### 1. Featured/promoted listings — agent-facing ads (primary bet)

**What:** agents pay to pin their listing on top of feed/map, or get a
"Verified agent / featured" badge. Price: $10–30/listing/month or
$50–150/month flat for an agent tier.

**Why first:** real money in this market sits with agents and landlords,
not renters. Renters won't pay much; agents already spend on ads
(Khmer24 paid bumps exist — proven willingness to pay). Our feed ordering
and map are surfaces we fully control.

**Implementation:**
- `properties.is_featured` + `featured_until` columns; sort featured first.
- "Promote" flow: agent contacts admin in Telegram → manual invoice
  (ABA/Wise/crypto) → admin flips flag. Zero payment integration needed
  for pilot — sell by hand first.
- Later: self-serve agent dashboard.
- Effort: S (schema + sort + admin toggle). Sell manually.

### 2. Premium renter subscription — "Early Bird" alerts

**What:** free users see the feed normally; premium ($3–5/mo) gets:
- instant push alerts for new listings matching saved criteria
  (the matcher engine already exists!),
- full contact reveal (optional), exact pins where we have them,
- ad-free / promoted listings muted.
Free tier: daily digest or delay of 24–48h for new-listing alerts.

**Why second:** uses existing matcher + notifier infrastructure. Renters
in a hot market (good Siem Reap units go in days) do pay for speed —
analogous to Idealista/Funda premium alert models. Risk: audience is
small & transient; churn high by nature (people find a flat and leave).
Position it as "1 month while you hunt", not annual plans.

**Implementation:**
- `users.subscription_until`, `role='premium'` or separate flag.
- Matcher: premium users → instant notify; free → digest/none.
- Payment links generated per-user (Stripe Payment Links / PayWay QR),
  webhook or manual admin confirmation flips the flag.
- Effort: M (payment plumbing is the only real work).

### 3. Concierge / done-for-you search — service revenue

**What:** "Tell us your budget & requirements — we shortlist 5 verified
listings, pre-check availability, arrange viewings." $15–30 per request,
or $50 for a full "arrival package" (listings + viewing schedule +
area advice). Fulfilled manually at first (the operator does the work).

**Why third:** highest willingness-to-pay per transaction among expats
landing blind in a new city; zero product work — sellable tomorrow via
a bot flow. Doesn't scale, but validates demand and pays for hosting.

**Implementation:**
- Bot command `/concierge` → intake form → admin ticket.
- Effort: XS. Pure service, no code beyond the form.

### 4. Lead-gen fee per signed lease — agent partnerships

**What:** charge agents a success fee ($20–50 or 10–20% of first month's
commission) when a renter closes a unit we surfaced.

**Reality check:** attribution is nearly impossible without CRM tracking —
renters leave the app and call agents directly. Only works if we generate
leads *through* the app (e.g. "request viewing" button → we broker the
intro). Possible later with a "Request viewing" feature that creates a
3-way chat. Effort: L. Defer until volume justifies.

### 5. Affiliate revenue — adjacent services

**What:** eSIM/airalo, travel insurance (SafetyWing), Wise/Remitly,
furniture/appliance rental, co-working spaces, tuk-tuk driver contacts,
Vietnam visa-run services. Contextual placement in the app
("Moving in? Get set up" section) and bot.

**Reality check:** low effort, low yield (affiliate payouts $1–10).
Good as a passive add-on once there's traffic, never a main model.
Effort: XS (links section + tracking).

### 6. Data/API licensing

**What:** sell normalized market data (price indices per sangkat,
inventory stats) to agencies/relocation companies/market analysts.

**Reality check:** needs months of accumulated, clean data and real
buyers. A quarterly "Siem Reap rental market report" could be a $50–200
product for relocation companies — nice later, not now. Effort: M.

### Explicitly rejected

- **Display ads (AdSense-style):** pennies at our scale, ruins UX.
- **Paywall on listings:** kills the only moat we have (coverage).
- **Taking rent deposits/payments:** licensing/escrow/legal nightmare
  in Cambodia, fraud surface, instant support burden. Never.
- **Listing fees for landlords:** landlords here don't self-serve;
  agents do. Covered by option 1.

---

## Recommended sequence

```text
Now        Option 3 concierge (bot command, manual) — immediate revenue signal
           Option 1 featured listings — manual sales to agents, schema flag
+1–2 mo    Option 2 premium alerts — after payment plumbing chosen
+3 mo      Option 5 affiliate strip in-app; revisit Option 4 if leads flow
Later      Option 6 market report when dataset matures
```

## What to build first (concrete)

1. `properties.is_featured` + `featured_until`, featured-first sort,
   small "Featured" pill in UI. Admin command `/feature <id> <days>`.
2. Bot `/concierge` intake → admin notification (reuse alertService).
3. `users.subscription_until` column (schema-only for now).
4. PostHog events for monetization funnel: `concierge_started`,
   `featured_impression`, `contact_lead_clicked` (already tracked —
   this is the metric to show agents).

## Metrics to watch

- `contact_lead_clicked` per property/week → proves lead value to agents
  (this is the sales pitch for Option 1).
- Pending→approved conversion, feed DAU → whether premium alerts have
  enough inventory velocity to be worth paying for.

## Open questions for the owner

1. Do you want to handle payments manually first (ABA/Wise/crypto invoice
   via DM), or integrate Stripe Payment Links from day one? Recommend
   manual until 5+ paying customers exist.
2. Is there a legal entity for collecting money? (Personal PayWay works
   for pilot; Stripe requires a business entity in a supported country.)
3. Featured listings disclosure — label them "Featured" transparently?
   (Recommend yes — trust is the product.)
