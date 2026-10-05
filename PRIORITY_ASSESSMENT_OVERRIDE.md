# Priority Assessment — Admin Override

How an admin acts on a single assessment, what is allowed to refuse that action,
and how each of those rules is proven.

---

## 1. The admin's lever

| Action | Endpoint | Who |
|---|---|---|
| Raise a Priority review | `PATCH /api/assessment/:id/priority` `{ "priority": "Priority" }` | admin |
| Release a Priority review | `PATCH /api/assessment/:id/priority` `{ "priority": "Standard" }` | admin |
| Delete an assessment | `DELETE /api/assessment/:id` | owner, or admin for anyone's |

`priority` must be exactly `"Priority"` or `"Standard"` — anything else is a
`400`. The caller must have `role: "admin"`; a user document with no `role` at
all is refused, and a non-admin is refused in **both** directions (a release-only
hole would let any user clear a severe case off someone else's account).

**Priority Assessment is a PREMIUM+ entitlement.** The *pause* it causes is only
enforced for a user who currently holds it, but a manual admin flag is not
tier-gated: an admin can always hold a review open, whatever the account pays
for. A downgraded user keeps the flag document for the admin view and is simply
no longer paused by it.

---

## 2. When a raise is refused

A Priority review only means something while the day's plan is still
outstanding. `409` (not `403`/`400`) is returned when the assessment is simply
not in a flaggable state. The body always carries `message`, `code`, `intake`
and `openAssessmentId`.

| `code` | Condition |
|---|---|
| `intake-complete` | Every supplement on the relevant day is already taken. |
| `already-open` | The user already has a *different* assessment open as Priority. |
| `invalid-assessment` | The document has no resolvable owner. Nothing is written. |

**Which day counts.** Today is evaluated when today has records. Otherwise the
most recent day that *has* records is evaluated. That fallback is the whole
point: someone who ticked everything off yesterday and is flagged this morning
has no records for today, so a today-only check reports "not complete" and the
gate stays up for a review they already finished — with no way to clear it,
because clearing it requires posting an intake.

A day is complete only if it has at least one record **and** all of them are
`taken`. An empty plan is "not started", never "complete" — otherwise a user
with no supplements could be flag-blocked permanently, and every one of their
flags auto-released.

Re-raising the *same* assessment is idempotent: the stacking query excludes the
target itself, so refreshing a flagged assessment does not trip the rule against
its own row. Releasing is **never** gated — the guard protects against raising,
and must not make a flag impossible to clear.

---

## 3. What each write does

**Raise** — `priority: 'Priority'`, `flaggedAt` stamped, `expiresAt: null` (a
Priority never expires while flagged), and any previous resolution cleared.

**Release** — restores `expiresAt` to `createdAt + 5 calendar years` (never
"5 years from now", which pushed old records' expiry years into the future),
stamps `resolvedAt`, and sets `resolvedReason: 'admin-resolved'`.

**Both** — create a `UserNotification` for the user and an `AdminEvent` for the
admin panel. Every other path that moves this flag notifies the user; the admin
override did not, so pausing someone's assessments was completely silent and
they met "New Assessments Paused" with no idea an admin had acted. Both writes
are best-effort: a failure there must not fail the override.

**Releasing is idempotent.** Setting `Standard` on an assessment that was never
flagged does *not* stamp a resolution. It used to, which rewrote the history of
a record nobody had flagged and — because the intake-undo path in
`POST /api/dashboard/intake` only re-flags rows whose reason is
`intake-complete` — silently disarmed the safety reinstatement for that record.

---

## 4. The repair, and why every read path has it

`selfHealOpenPriority()` releases any Priority whose plan is already finished.
It exists because flags were written before this guard existed, and nothing else
would ever clear them. It runs on **every** surface that reports or enforces the
block:

- `GET /api/assessment/priority-status`
- `GET /api/dashboard`
- `POST /api/assessment` (the submit itself)

`POST /api/assessment` used to ask first and heal never, so a user could be told
"not blocked" on two screens and refused with `403` on the one that mattered — a
lockout with no visible cause and no way out. Whichever surface the user reaches
first now gives the same answer.

A release performed by the repair:

- **restores `expiresAt`** from `createdAt`. A Priority row carries
  `expiresAt: null`, so releasing without putting the retention date back left
  the record permanently un-expirable.
- **writes an `AdminEvent`**. A flag can be an admin's deliberate decision, and
  silently reverting it leaves the admin panel showing a review the database no
  longer holds.

The repair is best-effort by contract: if it throws, the flag is left exactly as
it was and the request still answers.

---

## 5. A user cannot delete their way out

`DELETE /api/assessment/:id` on your own assessment is `409` with
`code: 'priority-open'` while it is under review. Delete was the way around the
entire gate: remove the document and the block goes with it — the severe case
disappears from the admin panel along with every intake record attached to it,
there is no audit entry, and the user is free to start fresh. Admins can still
delete (an audited, deliberate act), and any user can delete an assessment once
it is no longer flagged.

---

## 6. Other paths that raise the flag

Severity auto-flagging (`flagSevereAssessment`, re-run whenever AI results are
saved) goes through the same guard, and is gated on the user holding PREMIUM+.
The intake auto-lift in `POST /api/dashboard/intake` and its undo re-flag follow
the same entitlement. **A user cannot re-raise a gate they have already
satisfied** by re-saving results for a finished plan.

---

## 7. Running the checks

```bash
# Pure rule, no database, no mongoose — ~0.5 s
npx --prefix server node --test "server/Test File/priority-gate.test.js"

# Real router over HTTP with an in-memory store — no MongoDB needed
npx --prefix server node --test "server/Test File/admin-override.test.js"

# Everything
cd server && npm test          # 194 tests
cd server && npm run check     # syntax check

# Live: needs the API running and MONGO_URI set. Creates a throwaway user,
# exercises every branch, deletes everything it made.
cd server && npm start &
cd server && npm run test:priority    # 37 checks
```

`npm run test:priority` is the one to run after touching
`server/routes/assessment.js` or `server/utils/priorityGate.js` — it is the only
check that goes through real auth, real Mongo and the real server.

### Files

- `server/utils/priorityRules.js` — the rule, dependency-free and directly testable
- `server/utils/priorityGate.js` — the database-facing half (thin wrappers)
- `server/routes/assessment.js` — the override, the submit gate, the delete guard
- `server/Test File/priority-gate.test.js` — the rule
- `server/Test File/admin-override.test.js` — the override, end to end
- `server/test-priority-override-flows.js` — the live check
