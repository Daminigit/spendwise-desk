# Source manifest

Generated 2026-11-26 by `npm run eval` from the corpus the app loads ([`src/corpus/`](src/corpus)). 2 sources, 17 passages. Live view with the same ids: [https://spendwise-desk.onrender.com/sources](https://spendwise-desk.onrender.com/sources).

**Rules.** Public, official sources only: no blogs, no third-party summaries, no app back-end screenshots. Each passage is a short plain-English paraphrase of its source that says only what the source says. Every factual claim in a reply cites one passage id below, with its source link and last-checked date. A reply whose numbers are not in the cited passage is rejected by the reviewer in code.

## Sources

| # | Source | Publisher | URL | Last checked | Passages | Used for |
|---|---|---|---|---|---|---|
| 1 | Acme Travel Pvt Ltd expense policy | Acme Travel Pvt Ltd | https://spendwise-desk.onrender.com/settings/policy | 2026-11-26 (read live from the database on every answer) | 13 | The organisation's own expense rules: receipt and GSTIN thresholds, weekend rule, how flags work, category limits, policy notes |
| 2 | CGST Invoice Rules: Tax invoice | CBIC (Central Board of Indirect Taxes and Customs) | https://cbic-gst.gov.in/gst-invoice-rules.html | 2026-11-26 | 4 | What a GST tax invoice must show: supplier and recipient details, HSN/SAC, value and tax, place of supply, signature |

## Acme Travel Pvt Ltd expense policy

Acme Travel Pvt Ltd · https://spendwise-desk.onrender.com/settings/policy · last checked 2026-11-26. This source is the policy an admin sets in the app (Settings → Policy); the passages below are generated from it, so their figures change when the policy changes. Shown here for the demo organisation.

| Passage id | Heading | Text |
|---|---|---|
| `policy-receipts` | Receipts | A receipt image is required for any expense above ₹500.00. A claim missing a required receipt is flagged when it is submitted. |
| `policy-gstin` | Supplier GSTIN | The supplier's GSTIN is required for any expense above ₹2,000.00. A missing or invalid GSTIN is flagged for the approver. |
| `policy-weekend` | Weekend spend | Expenses dated on a Saturday or Sunday are allowed but flagged for the approver to check. |
| `policy-flags` | How policy checks work | Policy checks never block a claim. They add flags (over item limit, over daily limit, missing receipt, missing or invalid GSTIN, GST mismatch, weekend, outside trip dates, possible duplicate) that the approving manager sees before deciding. |
| `policy-categories` | Expense categories | The expense categories are: Client Entertainment, Lodging, Meals, Office Supplies, Other, Software, Travel. |
| `policy-limit-ent` | Client Entertainment limits | Client Entertainment (ENT): per-item limit ₹10,000.00; no daily limit. Spending over a limit is flagged for the approver, not blocked. |
| `policy-limit-lodge` | Lodging limits | Lodging (LODGE): per-item limit ₹6,000.00; no daily limit. Spending over a limit is flagged for the approver, not blocked. |
| `policy-limit-meals` | Meals limits | Meals (MEALS): per-item limit ₹1,500.00; daily limit ₹2,500.00. Spending over a limit is flagged for the approver, not blocked. |
| `policy-limit-office` | Office Supplies limits | Office Supplies (OFFICE): no per-item limit; no daily limit. Spending over a limit is flagged for the approver, not blocked. |
| `policy-limit-other` | Other limits | Other (OTHER): no per-item limit; no daily limit. Spending over a limit is flagged for the approver, not blocked. |
| `policy-limit-sw` | Software limits | Software (SW): no per-item limit; no daily limit. Spending over a limit is flagged for the approver, not blocked. |
| `policy-limit-travel` | Travel limits | Travel (TRAVEL): no per-item limit; no daily limit. Spending over a limit is flagged for the approver, not blocked. |
| `policy-notes` | Policy notes | Book economy class for flights under 4 hours. Hotels up to ₹6,000/night in metros. Client entertainment above ₹10,000 needs prior approval from your manager — attach the approval email. Alcohol is not reimbursable. Submit claims within 30 days of the expense. |

## CGST Invoice Rules: Tax invoice

CBIC (Central Board of Indirect Taxes and Customs) · https://cbic-gst.gov.in/gst-invoice-rules.html · last checked 2026-11-26.

| Passage id | Heading | Text |
|---|---|---|
| `cbic-invoice-supplier` | Supplier details, serial number and date | A tax invoice issued by a registered person must show the name, address and GSTIN of the supplier, a consecutive serial number unique for the financial year (letters, numerals, hyphen or slash), and the date the invoice was issued. |
| `cbic-invoice-recipient` | Recipient details | A tax invoice must show the recipient's name, address and GSTIN or UIN if the recipient is registered. If the recipient is unregistered and the taxable value is ₹50,000 or more, it must show the recipient name and address, the delivery address, and the name and code of the State. |
| `cbic-invoice-goods-tax` | Goods or services, value and tax | A tax invoice must show the HSN code of goods or accounting code of services, a description, quantity and unit for goods, the total value, the taxable value after any discount, the rate of tax and the amount of tax charged (central tax, State tax, integrated tax, Union territory tax or cess). |
| `cbic-invoice-place-signature` | Place of supply, reverse charge and signature | For an inter-State supply the invoice must show the place of supply with the State name, the delivery address if different, whether tax is payable on reverse charge, and the signature or digital signature of the supplier or an authorised representative. |

## Deliberately not included

These could not be verified on an official page on 2026-11-26, so questions about them come back as "not covered", naming the sources searched:

- CGST Act section 17(5), blocked input tax credit (CBIC's Act page returned 404).
- The structure of a GSTIN.

## How to add a source

Read the official page, add it to [`src/corpus/public-sources.ts`](src/corpus/public-sources.ts) with passages that say only what the page says, set `lastChecked` to the day you read it, and re-run `npm run eval` (which regenerates this file).
