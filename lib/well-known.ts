// Apple's domain-association file, served at the path Apple insists on.
//
// Registered on core's 'core.well-known-files' extension point. Apple fetches
// /.well-known/apple-developer-merchantid-domain-association from the live
// domain before it will show an Apple Pay sheet on it, follows no redirect to
// anywhere more convenient, and re-checks periodically thereafter - so the file
// has to be served from the domain itself, at that exact path, for as long as
// Apple Pay is switched on. That path is out of reach of this module's own
// /api/m/square-payment-for-shop/… routes, which is why core owns it and asks
// the modules what belongs there.
//
// The contents are whatever the owner pasted in on the Square settings tab,
// straight from Square's developer dashboard. Nothing is generated here and
// nothing is checked: only Apple knows whether the file is the right one, and
// it says so by refusing to verify the domain.
import { getSquareSettings } from '@/modules/square-payment-for-shop/lib/settings'

const APPLE_PAY_PATH = 'apple-developer-merchantid-domain-association'

export async function squareWellKnownFiles(): Promise<Record<string, string>> {
  const settings = await getSquareSettings()
  const contents = settings.applePayDomainAssociation.trim()
  // Nothing pasted in, or wallets switched off: the path 404s, exactly as it
  // did before this module was installed. An empty file served with a 200 is
  // worse than no file at all - Apple reads it as a failed verification rather
  // than an absent one.
  if (!contents || !settings.walletsEnabled) return {}
  return { [APPLE_PAY_PATH]: contents }
}
