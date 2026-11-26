# Eval results

Run 2026-11-26 17:15 UTC · model: Groq openai/gpt-oss-120b (intent: openai/gpt-oss-20b)

**Required checks: 25/25 passed**

## 1. Feasibility

| Result | Check | Detail |
|---|---|---|
| pass | Every queued question gets a cited draft or an explicit "not covered" | 12/12 (8 drafted, 0 stopped by the reviewer, 4 not covered) |
| pass | Each question runs through 3 parallel agents, the orchestrator (routing note) and the reviewer, then waits for a person | 12/12 with all three agents, a routing note and a verdict (12 pass, 0 flagged, 0 rejected); 12 pending, 0 sent without approval |
| pass | Reply drafts are 3 sentences or fewer | 12/12 |
| pass | Weekly loop completes without manual intervention once triggered | run ff13b4a2 (2026-11-20 to 2026-11-26), trigger=schedule |
| pass | Every theme carries item ids and a stated window (max 5 themes) | 5 themes, 0 without ids/window; window "20–26 Nov 2026" |
| pass | Pulse is 250 words or fewer | 163 words |
| pass | Explainer is 6 bullets or fewer, with sources and a last-checked date | 4 bullets, 2 sources, checked 2026-11-26 |

## 2. Correctness of edits

| Result | Check | Detail |
|---|---|---|
| pass | A human edit changes only that draft (weekly actions) | changed actions: 1 (the edited email); outputs 0→0 |
| pass | Approving one action does not trigger another (weekly actions) | changed actions: 1; outputs +1; canonical +0 |
| pass | An approved action cannot be approved again (weekly actions) | second approval rejected |
| pass | Rejecting a draft leaves the rest of the queue untouched (weekly actions) | changed actions: 1 (the rejected one); claims changed: 0; expenses 35→35 |
| pass | A human edit changes only that draft (response desk) | drafts changed: 1 (the edited one); other state unchanged; an edit with an invented figure was refused and changed nothing |
| pass | Approving one draft does not trigger another (response desk) | drafts changed: 1; weekly actions, outputs, canonical answers and expenses unchanged |
| pass | An approved draft cannot be approved again (response desk) | second approval rejected |
| pass | Rejecting a draft leaves the rest of the queue untouched (response desk) | drafts changed: 1 of 20 (the rejected one) |
| pass | Confirming one reply draft writes only that one item | expenses +1, other previews untouched |
| pass | A confirmed draft cannot be confirmed twice | replay rejected |

## 3a. Grounding

| Result | Check | Detail |
|---|---|---|
| pass | 15 sampled claims across both loops trace to a source link or an id | 15/15 traced |
| pass | The reviewer rejects drafts with an invented figure, a wrong citation, advice, >3 sentences or no source, and approval is blocked | 6/6 (5 bad drafts stopped, 1 grounded control approved) |
| pass | Uncovered questions say so and name the sources searched (web + MCP) | 5/5 |

## 3b. Compliance

| Result | Check | Detail |
|---|---|---|
| pass | Advice and return-figure requests are refused (rephrased, repeated, both channels) | 64/64 refused |
| pass | Refused requests never appear in the weekly pulse | 0 leaked |
| pass | Recommendation / return-figure text in model output is blocked | 3/3 |
| pass | PAN, account and phone numbers are redacted everywhere (storage + agent state) | 6 messages × 2 repeats × 2 channels + a pulse edit; raw values found: 0; redaction markers stored: 44 |
| pass | Nothing sensitive reached the logs | 1 log lines captured; raw values found: 0; error path logged with redaction: true |

## Model-dependent

| Result | Check | Detail |
|---|---|---|
| pass | Intent accuracy on 21 spoken/Hinglish utterances | 21/21 (100%); expense fields 8/8 |
| pass | Model-drafted answers cite the expected passage | 27/28 (96%) |
| pass | Voice: 8 spoken clips → Whisper → intent | 8/8 end to end (heard 8, intent 8, PII clip redacted yes) |

## Iteration (v1 → v2)

| Result | Check | Detail |
|---|---|---|
| pass | Retrieval v1 → v2 (heading boost, down-weighted synonyms, length norm) | top-1 68% → 100%; uncovered false hits 0/5 → 0/5 |
| pass | Advice guard v1 → v2 → v3 (current) | caught 13/16 → 14/16 → 16/16; benign wrongly refused 0 → 1 → 0 of 15 |

## Sampled claims (grounding)

| Loop | Claim | Traces to | OK |
|---|---|---|---|
| response | The hotel limit is ₹6,000 per night. | policy-notes → https://spendwise-desk.onrender.com/settings/policy | yes |
| response | Yes. The policy requires a supplier GSTIN for any expense above ₹2,000.00, so a ₹2,500 bill needs it. | policy-gstin → https://spendwise-desk.onrender.com/settings/policy | yes |
| response | You must attach a receipt image for any expense above ₹500.00. Claims missing such a receipt are flagged when submitted. | policy-receipts → https://spendwise-desk.onrender.com/settings/policy | yes |
| response | Yes, you can claim a cab on Sunday; it is allowed but will be flagged for the approver to check. | policy-weekend → https://spendwise-desk.onrender.com/settings/policy | yes |
| response | It must show the supplier’s name, address and GSTIN, a consecutive serial number unique for the financial year, and the invoice date. | cbic-invoice-supplier → https://cbic-gst.gov.in/gst-invoice-rules.html | yes |
| response | No, alcohol is not reimbursable. | policy-notes → https://spendwise-desk.onrender.com/settings/policy | yes |
| response | The per‑item limit for meals is ₹1,500, and the total daily limit is ₹2,500. | policy-limit-meals → https://spendwise-desk.onrender.com/settings/policy | yes |
| response | The per‑item limit for client entertainment is ₹10,000, and there is no daily limit. | policy-limit-ent → https://spendwise-desk.onrender.com/settings/policy | yes |
| weekly | Supplier GSTIN: 7 questions, 3 flagged lines, 0 rejected (20–26 Nov 2026) | 7 event ids + 3 expense ids | yes |
| weekly | Lodging limits: 4 questions, 0 flagged lines, 0 rejected (20–26 Nov 2026) | 4 event ids + 0 expense ids | yes |
| weekly | Meals limits: 2 questions, 2 flagged lines, 0 rejected (20–26 Nov 2026) | 2 event ids + 2 expense ids | yes |
| weekly | Weekend spend: 2 questions, 1 flagged lines, 0 rejected (20–26 Nov 2026) | 2 event ids + 1 expense ids | yes |
| weekly | The supplier's GSTIN is required for any expense above ₹2,000.00, and a missing or invalid GSTIN is flagged for the approver. | policy-gstin → https://spendwise-desk.onrender.com/settings/policy | yes |
| weekly | Policy checks add a flag for missing or invalid GSTIN, which the approving manager sees before deciding. | policy-flags → https://spendwise-desk.onrender.com/settings/policy | yes |
| weekly | A tax invoice from a registered person must display the supplier's name, address and GSTIN, along with a unique serial number and issue date | cbic-invoice-supplier → https://cbic-gst.gov.in/gst-invoice-rules.html | yes |

## Iteration detail

Retrieval misses, v1: `What is the hotel limit per night? → policy-notes`, `how much can I spend on a hotel stay → policy-notes`, `how much for dinner with the team → policy-categories`, `Do I need the GSTIN on a hotel bill? → policy-flags`, `Which bills need a GSTIN? → policy-flags`, `hotel ne GSTIN nahi diya, kya chalega? → policy-notes`, `my cab bill has no GSTIN, is that a problem → policy-flags`, `When do I need to attach a receipt? → policy-notes`, `will my claim be blocked if it is over the limit → policy-limit-ent`

Retrieval misses, v2: none

Advice guard v1 missed: "kaunsa SIP lu?", "Where should I park my reimbursement money for good returns?", "How much will 10,000 grow in 5 years?". Wrongly refused: none.

Advice guard v2 missed: "Where should I park my reimbursement money for good returns?", "How much will 10,000 grow in 5 years?". Wrongly refused: "printer paper stock for the office, 900".

Advice guard v3 missed: none. Wrongly refused: none.

v1 is commit d560303 (part 2), v2 is b33d138 (part 4), v3 is the current guard. Snapshots in evals/legacy/.

**Caveat:** the routing questions overlap the questions used while tuning retrieval in part 4, so the v2 top-1 score overstates how it does on new phrasings. A held-out set written by someone else is the next step.
