# Kenya monthly payroll — scope and reviewed sources

Rule identifier: KE-MONTHLY-2026.02. Supported months: February–December 2026. Review date: 24 October 2026. Future and older periods are refused rather than silently applying the wrong NSSF limits.

## Sources

- [KRA PAYE](https://www.kra.go.ke/individual/filing-paying/types-of-taxes/paye): monthly progressive bands, resident personal relief, allowable deductions, insurance relief and Affordable Housing Levy.
- [KRA employer guidance](https://www.kra.go.ke/news-center/public-notices/2307-guidance-on-employer-obligations-in-applying-income-tax-deductions%2C-reliefs-and-exemptions): deductions/reliefs require eligible employee declarations and supporting documentation.
- [Official NSSF Year 4 notice](https://www.nssf.or.ke/notice-to-employers-year-4-2026-nssf-contribution-rates/notice), also [government-hosted notice](https://www.mygov.go.ke/sites/default/files/2026-02/Notice%20To%20Employers%20%E2%80%94%20Year%204%20%282026%29%20NSSF%20Contribution%20Rates%20.pdf).
- [Ministry of Health SHIF regulations](https://health.go.ke/sites/default/files/2024-11/Social%20Health%20Insurance%20%28General%29%20Regulations%2C%202024_0.pdf): salaried contribution basis and minimum.
- [NITA employer guidance](https://www.nita.go.ke/faq-s/99-nita-services): employer levy, not an employee deduction.

## Calculation

All values are integer KES minor units. Percentage arithmetic uses BigInt and half-up rounding to a minor unit. Tax bands apply progressively, not as one rate on all earnings.

Ordinary monthly cash salary is reviewed separately from pensionable pay and taxable non-cash benefits. Employee NSSF is 6% of pensionable earnings capped at KES 108,000; employer matches it. SHIF uses 2.75% of cash gross with a KES 300 minimum. Employee and employer housing levy each use 1.5% of cash gross. Documented pension, mortgage and post-retirement medical deductions have statutory caps; residency controls personal and insurance relief. The reviewer must check eligibility and supporting records. Where NITA applies, KES 50 is employer-paid; excluding it requires a recorded exemption basis.

Actual cash salary for partial months is an explicit input. No automatic proration, exemption-certificate calculation, irregular remuneration classification, expat treaty treatment, pension-exemption determination, benefits valuation, annual reconciliation, tax filing or government remittance is claimed. Complex employment cases require payroll review before using this ordinary monthly calculation. No payroll is generated or posted automatically.

## Review and records

Draft creation stores a calculation and employee snapshot; it posts nothing. A different authorised reviewer approves and posts to the organisation's existing ledger. Another authorised person records externally completed wage payments or remittances. Payroll liabilities and wages use the operating account; no owner funds, tenant deposits or rent receivables are involved.

Approved unpaid runs can be reversed by a reviewer other than the preparer and approver, only before any remittance is recorded. Paid runs and remitted liabilities cannot be silently edited or deleted. Corrections after actual disbursement require a separately reconciled recovery; that workflow is not automated by this release. Reversed/cancelled runs remain available and a replacement month may be prepared.

Payslips are printable/saveable as PDF and payroll rows can be exported as CSV. The CSV is an operational export, not an official KRA/NSSF/SHA submission format. Email delivery, salary transfers and statutory submissions are not enabled.
