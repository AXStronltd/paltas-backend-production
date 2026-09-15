-- PALTAS Connect: attribute a reservation to the channel that sold it.
--
-- Additive and nullable on purpose. Every existing reservation keeps its
-- free-text `source` and gets a NULL `channelId`, which reads as "nobody
-- attributed this" rather than as a guess. Back-filling by matching the
-- channel name against the source string is exactly the inference this
-- column exists to replace, so it is not done here.

ALTER TABLE "Reservation" ADD COLUMN "channelId" TEXT;

CREATE INDEX "Reservation_orgId_channelId_idx" ON "Reservation"("orgId", "channelId");

-- SET NULL, not CASCADE: unlinking a channel must never delete the
-- reservations it sold. The stay happened; the attribution is what is gone.
ALTER TABLE "Reservation"
  ADD CONSTRAINT "Reservation_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
