-- Where the shopper types their card: on Square's own hosted checkout page (a
-- redirect away and back), or in Square's card fields drawn on this site's own
-- checkout.
--
-- Both take the card through Square's own frames, so neither one lets a card
-- number touch this site. The difference is the trip: the hosted page is a
-- redirect to squareup.com and back, and a fair number of shoppers never come
-- back from it. On-page keeps them on the checkout they started on.
--
-- Defaults to 'hosted', which is what every shop taking Square payments before
-- this column existed was doing. It has to: on-page needs the Square
-- Application ID as well, and no existing shop has been asked for one - so a
-- default of 'on-page' would have switched a working card payment off on
-- somebody's live shop the moment they updated the module.
ALTER TABLE "sqp_settings" ADD COLUMN IF NOT EXISTS "card_entry" TEXT NOT NULL DEFAULT 'hosted';

ALTER TABLE "sqp_settings" DROP CONSTRAINT IF EXISTS "sqp_settings_card_entry_check";
ALTER TABLE "sqp_settings" ADD CONSTRAINT "sqp_settings_card_entry_check"
    CHECK ("card_entry" IN ('hosted', 'on-page'));
