/**
 * src/corpus/public-sources.ts
 *
 * Public, official sources only (no blogs, no third-party summaries). Each
 * passage is a short plain-English paraphrase of the official page, so the
 * answer can cite the page and the date it was last checked.
 *
 * To add a source: read the official page, write passages that say only what
 * the page says, set lastChecked to the day you read it.
 *
 * Deliberately NOT included (could not be verified from an official page on
 * 2026-11-26, so the assistant says "not covered" instead of guessing):
 *   - CGST Act section 17(5), blocked input tax credit (CBIC's Act page 404s)
 *   - the structure of a GSTIN
 */

export interface SourceDoc {
  id: string;
  title: string;
  publisher: string;
  url: string;
  lastChecked: string; // YYYY-MM-DD
  passages: { id: string; heading: string; text: string }[];
}

export const PUBLIC_SOURCES: SourceDoc[] = [
  {
    id: 'cbic-invoice-rules',
    title: 'CGST Invoice Rules: Tax invoice',
    publisher: 'CBIC (Central Board of Indirect Taxes and Customs)',
    url: 'https://cbic-gst.gov.in/gst-invoice-rules.html',
    lastChecked: '2026-11-26',
    passages: [
      {
        id: 'cbic-invoice-supplier',
        heading: 'Supplier details, serial number and date',
        text:
          'A tax invoice issued by a registered person must show the name, address and GSTIN of the supplier, ' +
          'a consecutive serial number unique for the financial year (letters, numerals, hyphen or slash), ' +
          'and the date the invoice was issued.',
      },
      {
        id: 'cbic-invoice-recipient',
        heading: 'Recipient details',
        text:
          "A tax invoice must show the recipient's name, address and GSTIN or UIN if the recipient is registered. " +
          'If the recipient is unregistered and the taxable value is ₹50,000 or more, it must show the recipient name and address, ' +
          'the delivery address, and the name and code of the State.',
      },
      {
        id: 'cbic-invoice-goods-tax',
        heading: 'Goods or services, value and tax',
        text:
          'A tax invoice must show the HSN code of goods or accounting code of services, a description, quantity and unit for goods, ' +
          'the total value, the taxable value after any discount, the rate of tax and the amount of tax charged ' +
          '(central tax, State tax, integrated tax, Union territory tax or cess).',
      },
      {
        id: 'cbic-invoice-place-signature',
        heading: 'Place of supply, reverse charge and signature',
        text:
          'For an inter-State supply the invoice must show the place of supply with the State name, the delivery address if different, ' +
          'whether tax is payable on reverse charge, and the signature or digital signature of the supplier or an authorised representative.',
      },
    ],
  },
];
