/* ====================================================================== *
 * DOES IT WORK ON PAPER.
 *
 * ONE COPY OF THE ARITHMETIC, in domain rather than in a route, because two
 * things need it and they are on opposite sides of the service: the resource
 * declaration sends these figures out beside every study, and the decide
 * route refuses to approve one whose own numbers say no.
 *
 * It lived in the route first, and the registry importing it dragged the
 * whole transport layer — config, sessions, Express — into a file that is
 * meant to be a description of tables. The dependency only goes one way:
 * routes may read domain, domain may not read routes.
 * ====================================================================== */

/**
 * The numbers, worked out.
 *
 * NOTHING HERE IS STORED. Every one of these follows from the inputs, and a
 * stored copy is one that disagrees with them the first time a cost changes
 * and nothing recalculates. Basis points rather than a percentage float, so
 * two studies with the same inputs cannot differ in the last digit.
 */
export function feasibilityNumbers(f) {
  const total = f.landCost + f.buildCost + f.professional + f.financeCost + f.otherCost;
  const profit = f.grossValue - total;
  /* On COST, which is the convention a developer means by "margin" — and it
     is said out loud below, because the other convention (on value) gives a
     different number from the same figures. */
  const marginBps = total > 0n ? Number((profit * 10000n) / total) : 0;
  /* What the land could have cost and still hit the target. The number a
     feasibility exists to produce. */
  const built = f.buildCost + f.professional + f.financeCost + f.otherCost;
  const target = BigInt(f.targetMarginBps);
  const residual = target > 0n
    ? (f.grossValue * 10000n) / (10000n + target) - built
    : f.grossValue - built;

  return {
    totalCost: String(total),
    profit: String(profit),
    marginBps,
    marginOnCost: `${(marginBps / 100).toFixed(2)}%`,
    residualLandValue: String(residual > 0n ? residual : 0n),
    /* Whether the land it is actually being bought for leaves enough. */
    viable: f.grossValue > 0n && profit > 0n
      && (f.targetMarginBps === 0 || marginBps >= f.targetMarginBps),
    basis: "Margin is on cost, not on value. The two give different numbers " +
           "from the same figures, and this is the one developers mean.",
  };
}

