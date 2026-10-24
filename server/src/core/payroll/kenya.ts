/** Versioned Kenya monthly payroll calculation. Integer minor units; no live tax filing or money movement.
 * Sources and scope: docs/finance/kenya-payroll.md. Reviewed cash monthly payroll, Feb–Dec 2026.
 */
export interface KenyaInput {
  grossMinor: number;
  pensionableMinor: number;
  taxableBenefitsMinor: number;
  resident: boolean;
  nitaLiable: boolean;
  pensionMinor: number;
  mortgageMinor: number;
  medicalMinor: number;
  insurancePremiumMinor: number;
  otherDeductionsMinor: number;
  otherEmployerMinor: number;
}
const ratio = (n: number, bp: number) => Number((BigInt(n) * BigInt(bp) + 5000n) / 10000n);
export function kenyaMonthly(input: KenyaInput, period: string) {
  if (!/^2026-(0[2-9]|1[0-2])$/.test(period))
    throw new Error(
      "Kenya rule version supports February–December 2026. Configure and review another period before using it.",
    );
  for (const v of [
    input.grossMinor,
    input.pensionableMinor,
    input.taxableBenefitsMinor,
    input.pensionMinor,
    input.mortgageMinor,
    input.medicalMinor,
    input.insurancePremiumMinor,
    input.otherDeductionsMinor,
    input.otherEmployerMinor,
  ])
    if (!Number.isSafeInteger(v) || v < 0 || v > 100000000000)
      throw new Error("Payroll amounts must be valid non-negative minor units.");
  const i = input,
    gross = i.grossMinor;
  if (gross <= 0 || i.pensionableMinor > gross)
    throw new Error("Gross pay must be positive and pensionable pay cannot exceed cash gross.");
  const nssf = ratio(Math.min(i.pensionableMinor, 10800000), 600),
    shif = Math.max(30000, ratio(gross, 275)),
    ahl = ratio(gross, 150);
  const pensionAllowance = Math.min(3000000, nssf + i.pensionMinor),
    medicalAllowance = Math.min(1500000, i.medicalMinor),
    mortgageAllowance = Math.min(3000000, i.mortgageMinor);
  const taxable = Math.max(
    0,
    gross + i.taxableBenefitsMinor - pensionAllowance - medicalAllowance - mortgageAllowance - shif - ahl,
  );
  let rest = taxable,
    tax = 0;
  for (const [width, bp] of [
    [2400000, 1000],
    [833300, 2500],
    [46766700, 3000],
    [30000000, 3250],
    [Number.MAX_SAFE_INTEGER, 3500],
  ] as const) {
    const amount = Math.min(rest, width);
    tax += ratio(amount, bp);
    rest -= amount;
    if (!rest) break;
  }
  const personalRelief = i.resident ? 240000 : 0,
    insuranceRelief = i.resident ? Math.min(500000, ratio(i.insurancePremiumMinor, 1500)) : 0;
  const paye = Math.max(0, tax - personalRelief - insuranceRelief);
  const deductions = nssf + shif + ahl + paye + i.pensionMinor + i.medicalMinor + i.otherDeductionsMinor;
  const net = gross - deductions;
  if (net < 0) throw new Error("Deductions exceed cash gross pay. Review the salary and deductions.");
  const nita = i.nitaLiable ? 5000 : 0;
  const employer = nssf + ahl + nita + i.otherEmployerMinor;
  const result = {
    ruleVersion: "KE-MONTHLY-2026.02",
    grossMinor: gross,
    taxableMinor: taxable,
    taxBeforeReliefMinor: tax,
    personalReliefMinor: personalRelief,
    insuranceReliefMinor: insuranceRelief,
    payeMinor: paye,
    nssfMinor: nssf,
    shifMinor: shif,
    ahlMinor: ahl,
    otherDeductionsMinor: i.pensionMinor + i.medicalMinor + i.otherDeductionsMinor,
    employerNssfMinor: nssf,
    employerAhlMinor: ahl,
    otherEmployerMinor: i.otherEmployerMinor,
    nitaMinor: nita,
    employerMinor: employer,
    netMinor: net,
    totalCostMinor: gross + employer,
  };
  if (Object.values(result).some((v) => typeof v === "number" && (!Number.isSafeInteger(v) || v > 100000000000)))
    throw new Error("Payroll totals exceed the supported amount limit. Review the inputs.");
  return result;
}
export type KenyaCalculation = ReturnType<typeof kenyaMonthly>;
