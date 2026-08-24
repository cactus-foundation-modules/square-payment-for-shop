-- Apple Pay and Google Pay buttons on the shop's own checkout, above "Place
-- order". Both are drawn by Square's Web Payments SDK from the same credentials
-- the on-page card fields already use, so there is nothing new to store except
-- whether the owner wants them and the file Apple insists the domain serves.
--
-- Defaults to false, and has to. A shop that updates this module has not been
-- through Apple's domain verification, so an Apple Pay button switched on by
-- the update would greet its shoppers with a sheet that fails - and the owner
-- would have no idea why. Off until somebody chooses it.
ALTER TABLE "sqp_settings" ADD COLUMN IF NOT EXISTS "wallets_enabled" BOOLEAN NOT NULL DEFAULT false;

-- The contents of the domain-association file Square hands the owner when they
-- register the site's domain for Apple Pay. Apple fetches it from
-- /.well-known/apple-developer-merchantid-domain-association on the live
-- domain, follows no redirect to anywhere more convenient, and refuses to show
-- an Apple Pay sheet on a domain that has not answered.
--
-- It is a verification token, not a secret: it proves the domain is the one
-- that registered, and it is served publicly by design. Google Pay needs no
-- equivalent - Square vouches for the merchant there.
ALTER TABLE "sqp_settings" ADD COLUMN IF NOT EXISTS "apple_pay_domain_association" TEXT;
