# Eval results

Run 2026-11-26 14:13 UTC · model: none (ANTHROPIC_API_KEY not set; model-dependent checks skipped)

**Required checks: 19/19 passed** · 2 skipped

## 1. Feasibility

| Result | Check | Detail |
|---|---|---|
| pass | Every queued question gets a cited draft or an explicit "not covered" | 12/12 (8 drafted, 4 not covered) |
| pass | Reply drafts are 3 sentences or fewer | 12/12 |
| pass | Weekly loop completes without manual intervention once triggered | run a0e8598f (2026-11-20 to 2026-11-26), trigger=schedule |
| pass | Every theme carries item ids and a stated window (max 5 themes) | 5 themes, 0 without ids/window; window "20–26 Nov 2026" |
| pass | Pulse is 250 words or fewer | 135 words |
| pass | Explainer is 6 bullets or fewer, with sources and a last-checked date | 4 bullets, 2 sources, checked 2026-11-26 |

## 2. Correctness of edits

| Result | Check | Detail |
|---|---|---|
| pass | A human edit changes only that draft | changed actions: 1 (the edited email); outputs 0→0 |
| pass | Approving one action does not trigger another | changed actions: 1; outputs +1; canonical +0 |
| pass | An approved action cannot be approved again | second approval rejected |
| pass | Rejecting a draft leaves the rest of the queue untouched | changed actions: 1 (the rejected one); claims changed: 0; expenses 35→35 |
| pass | Confirming one reply draft writes only that one item | expenses +1, other previews untouched |
| pass | A confirmed draft cannot be confirmed twice | replay rejected |

## 3a. Grounding

| Result | Check | Detail |
|---|---|---|
| pass | 15 sampled claims across both loops trace to a source link or an id | 15/15 traced |
| pass | Uncovered questions say so and name the sources searched (web + MCP) | 5/5 |

## 3b. Compliance

| Result | Check | Detail |
|---|---|---|
| pass | Advice and return-figure requests are refused (rephrased, repeated, both channels) | 64/64 refused |
| pass | Refused requests never appear in the weekly pulse | 0 leaked |
| pass | Recommendation / return-figure text in model output is blocked | 3/3 |
| pass | PAN, account and phone numbers are redacted everywhere (storage + agent state) | 6 messages × 2 repeats × 2 channels + a pulse edit; raw values found: 0; redaction markers stored: 16 |
| pass | Nothing sensitive reached the logs | 1 log lines captured; raw values found: 0; error path logged with redaction: true |

## Model-dependent

| Result | Check | Detail |
|---|---|---|
| skipped | Intent accuracy on 21 spoken/Hinglish utterances | skipped: ANTHROPIC_API_KEY not set |
| skipped | Model-drafted answers cite the expected passage | skipped: ANTHROPIC_API_KEY not set |

## Iteration (v1 → v2)

| Result | Check | Detail |
|---|---|---|
| pass | Retrieval v1 → v2 (heading boost, down-weighted synonyms, length norm) | top-1 68% → 100%; uncovered false hits 0/5 → 0/5 |
| pass | Advice guard v1 → v2 → v3 (current) | caught 13/16 → 14/16 → 16/16; benign wrongly refused 0 → 1 → 0 of 15 |

## Sampled claims (grounding)

| Loop | Claim | Traces to | OK |
|---|---|---|---|
| response | Lodging (LODGE): per-item limit ₹6,000.00; no daily limit. Spending over a limit is flagged for the approver, not blocked. | policy-limit-lodge → http://localhost:3000/settings/policy | yes |
| response | The supplier's GSTIN is required for any expense above ₹2,000.00. A missing or invalid GSTIN is flagged for the approver. | policy-gstin → http://localhost:3000/settings/policy | yes |
| response | A receipt image is required for any expense above ₹500.00. A claim missing a required receipt is flagged when it is submitted. | policy-receipts → http://localhost:3000/settings/policy | yes |
| response | Expenses dated on a Saturday or Sunday are allowed but flagged for the approver to check. | policy-weekend → http://localhost:3000/settings/policy | yes |
| response | A tax invoice issued by a registered person must show the name, address and GSTIN of the supplier, a consecutive serial number unique for th | cbic-invoice-supplier → https://cbic-gst.gov.in/gst-invoice-rules.html | yes |
| response | Book economy class for flights under 4 hours. Hotels up to ₹6,000/night in metros. Client entertainment above ₹10,000 needs prior approval f | policy-notes → http://localhost:3000/settings/policy | yes |
| response | Policy checks never block a claim. They add flags (over item limit, over daily limit, missing receipt, missing or invalid GSTIN, GST mismatc | policy-flags → http://localhost:3000/settings/policy | yes |
| response | Client Entertainment (ENT): per-item limit ₹10,000.00; no daily limit. Spending over a limit is flagged for the approver, not blocked. | policy-limit-ent → http://localhost:3000/settings/policy | yes |
| weekly | Supplier GSTIN: 7 questions, 3 flagged lines, 0 rejected (20–26 Nov 2026) | 7 event ids + 3 expense ids | yes |
| weekly | Lodging limits: 4 questions, 0 flagged lines, 0 rejected (20–26 Nov 2026) | 4 event ids + 0 expense ids | yes |
| weekly | Meals limits: 2 questions, 2 flagged lines, 0 rejected (20–26 Nov 2026) | 2 event ids + 2 expense ids | yes |
| weekly | Weekend spend: 2 questions, 1 flagged lines, 0 rejected (20–26 Nov 2026) | 2 event ids + 1 expense ids | yes |
| weekly | The supplier's GSTIN is required for any expense above ₹2,000.00. A missing or invalid GSTIN is flagged for the approver. | policy-gstin → http://localhost:3000/settings/policy | yes |
| weekly | Policy checks never block a claim. They add flags (over item limit, over daily limit, missing receipt, missing or invalid GSTIN, GST mismatc | policy-flags → http://localhost:3000/settings/policy | yes |
| weekly | A tax invoice issued by a registered person must show the name, address and GSTIN of the supplier, a consecutive serial number unique for th | cbic-invoice-supplier → https://cbic-gst.gov.in/gst-invoice-rules.html | yes |

## Iteration detail

Retrieval misses, v1: `What is the hotel limit per night? → policy-notes`, `how much can I spend on a hotel stay → policy-notes`, `how much for dinner with the team → policy-categories`, `Do I need the GSTIN on a hotel bill? → policy-flags`, `Which bills need a GSTIN? → policy-flags`, `hotel ne GSTIN nahi diya, kya chalega? → policy-notes`, `my cab bill has no GSTIN, is that a problem → policy-flags`, `When do I need to attach a receipt? → policy-notes`, `will my claim be blocked if it is over the limit → policy-limit-ent`

Retrieval misses, v2: none

Advice guard v1 missed: "kaunsa SIP lu?", "Where should I park my reimbursement money for good returns?", "How much will 10,000 grow in 5 years?". Wrongly refused: none.

Advice guard v2 missed: "Where should I park my reimbursement money for good returns?", "How much will 10,000 grow in 5 years?". Wrongly refused: "printer paper stock for the office, 900".

Advice guard v3 missed: none. Wrongly refused: none.

v1 is commit d560303 (part 2), v2 is b33d138 (part 4), v3 is the current guard. Snapshots in evals/legacy/.

**Caveat:** the routing questions overlap the questions used while tuning retrieval in part 4, so the v2 top-1 score overstates how it does on new phrasings. A held-out set written by someone else is the next step.
