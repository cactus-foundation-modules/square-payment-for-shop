'use client'

// "Square" panel. The manifest settingsTabs entry sets host "shop.payments", so
// this renders inside admin > Shop > Payments alongside Stripe and PayPal
// rather than as a top-level Settings tab. Credentials are stored as
// environment variables through the core-managed /api/admin/env route (declared
// via requiredEnvVars); the on/off toggle, the payment description and the
// choice of environment are this module's own settings.
//
// The environment picker deliberately does NOT go through /api/admin/env. An
// environment variable written there only reaches the running server at the
// next deployment, so the panel would re-read the old value the moment it
// reloaded and put the dropdown straight back where it started - a save that
// looked like a failure. Being a stored setting, it applies immediately.
//
// Sandbox and production have their own separate boxes, because they have their
// own separate credentials. Both sets are shown at once so "(set)" always means
// "set for that environment" - one shared set of fields made a saved production
// token look like a saved sandbox token.
import { useEffect, useState } from 'react'

type Environment = 'sandbox' | 'production'

const ENVIRONMENTS: Array<{ id: Environment; label: string; hint: string }> = [
  { id: 'sandbox', label: 'Sandbox', hint: 'Test cards only, no real money.' },
  { id: 'production', label: 'Production', hint: 'Real cards, real money.' },
]

type FieldDef = {
  field: 'accessToken' | 'applicationId' | 'locationId' | 'webhookSignatureKey'
  label: string
  placeholder: string
  secret: boolean
  optional?: boolean
  help?: string
}

const FIELDS: FieldDef[] = [
  {
    field: 'accessToken',
    label: 'Access token',
    placeholder: 'EAAA…',
    secret: true,
    help: 'Square developer dashboard → your app → Credentials.',
  },
  {
    field: 'applicationId',
    label: 'Application ID',
    placeholder: 'sq0idp-…',
    secret: false,
    optional: true,
    help: 'On the same page as the access token. Only needed if you take the card on your own checkout - the Square page does not use it.',
  },
  {
    field: 'locationId',
    label: 'Location ID',
    placeholder: 'L…',
    secret: false,
    help: 'The shop payments are taken under. Use Look up locations rather than hunting for it - Square keeps it on its own page, away from the credentials.',
  },
  {
    field: 'webhookSignatureKey',
    label: 'Webhook signature key',
    placeholder: '••••••••',
    secret: true,
    optional: true,
    help: 'Shown against the webhook subscription once you have added the URL below. Optional, but without it a shopper who closes the Square tab instead of coming back has to be confirmed by hand.',
  },
]

// Must match squareEnvVarNames() in lib/env.ts.
const ENV_VAR_SUFFIX: Record<FieldDef['field'], string> = {
  accessToken: 'ACCESS_TOKEN',
  applicationId: 'APPLICATION_ID',
  locationId: 'LOCATION_ID',
  webhookSignatureKey: 'WEBHOOK_SIGNATURE_KEY',
}

function envVarName(environment: Environment, field: FieldDef['field']): string {
  const prefix = environment === 'sandbox' ? 'SQUARE_SANDBOX_' : 'SQUARE_'
  return `${prefix}${ENV_VAR_SUFFIX[field]}`
}

type Status = {
  configured: boolean
  connected?: boolean
  environment: string
  cardEntry?: CardEntry
  webhookConfigured?: boolean
  // One flag per credential, as the RUNNING server sees them - which is not the
  // same question as whether they have been saved. See missingCredentials.
  accessTokenSet?: boolean
  locationIdSet?: boolean
  applicationIdSet?: boolean
  error?: string
}

// Joins a list into the sentence an actual person would say.
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

type CardEntry = 'hosted' | 'on-page'

type Settings = {
  enabled: boolean
  paymentDescription: string
  environment: Environment
  cardEntry: CardEntry
  walletsEnabled: boolean
  applePayDomainAssociation: string
}

type SqLocation = { id: string; name: string; status: string; currency: string | null }

export function SquareSettingsTab() {
  const [setVars, setSetVars] = useState<Record<string, boolean>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [environment, setEnvironment] = useState<Environment>('sandbox')
  const [localMode, setLocalMode] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  const [locations, setLocations] = useState<Record<Environment, SqLocation[]>>({ sandbox: [], production: [] })
  const [lookingUp, setLookingUp] = useState<Environment | null>(null)
  const [lookupError, setLookupError] = useState<Record<string, string>>({})

  const [savingConn, setSavingConn] = useState(false)
  const [savedConn, setSavedConn] = useState(false)
  const [connError, setConnError] = useState('')

  const [savingSettings, setSavingSettings] = useState(false)
  const [savedSettings, setSavedSettings] = useState(false)
  const [settingsError, setSettingsError] = useState('')

  const [webhookUrl, setWebhookUrl] = useState('')

  async function load() {
    try {
      const [envRes, statusRes, settingsRes] = await Promise.all([
        fetch('/api/admin/env'),
        fetch('/api/m/square-payment-for-shop/admin/status'),
        fetch('/api/m/square-payment-for-shop/admin/settings'),
      ])
      if (envRes.ok) {
        const d = await envRes.json()
        setSetVars(d.vars ?? {})
        setLocalMode(!!d.localMode)
      }
      if (statusRes.ok) setStatus((await statusRes.json()) as Status)
      if (settingsRes.ok) {
        const s = (await settingsRes.json()) as Settings
        setSettings(s)
        if (s.environment === 'production' || s.environment === 'sandbox') setEnvironment(s.environment)
      }
    } catch {
      // Sections still render with defaults.
    }
  }

  useEffect(() => {
    // window.location is only available post-mount; deriving this during render
    // would cause a hydration mismatch.
    setWebhookUrl(`${window.location.origin}/api/m/square-payment-for-shop/webhook`)
    load()
  }, [])

  async function lookUpLocations(env: Environment) {
    setLookingUp(env)
    setLookupError((e) => ({ ...e, [env]: '' }))
    try {
      const typedToken = values[envVarName(env, 'accessToken')]?.trim()
      const res = await fetch('/api/m/square-payment-for-shop/admin/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: env, accessToken: typedToken || undefined }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Could not reach Square')
      const found = (d.locations ?? []) as SqLocation[]
      setLocations((l) => ({ ...l, [env]: found }))
      const only = found.length === 1 ? found[0] : undefined
      if (found.length === 0) {
        setLookupError((e) => ({ ...e, [env]: 'That token has no locations on it.' }))
      } else if (only) {
        // One location is the common case - fill it in rather than make them pick.
        setValues((v) => ({ ...v, [envVarName(env, 'locationId')]: only.id }))
      }
    } catch (err) {
      setLookupError((e) => ({ ...e, [env]: err instanceof Error ? err.message : 'Could not reach Square' }))
    } finally {
      setLookingUp(null)
    }
  }

  async function saveConnection() {
    setSavingConn(true)
    setSavedConn(false)
    setConnError('')
    try {
      // Only non-blank fields are sent, so a blank box leaves the stored value
      // alone rather than wiping it.
      const vars = Object.entries(values)
        .map(([key, value]) => ({ key, value: value.trim() }))
        .filter((v) => v.value !== '')
      // The environment is saved on the spot by its own picker, so an untouched
      // form really has nothing to send. Saying "Saved" over an empty POST is
      // how a credential ends up looking stored when nothing happened.
      if (vars.length === 0) {
        throw new Error('Nothing to save - fill in an access token or location ID first.')
      }

      const res = await fetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      // Core only stores keys the installed modules declare. If it dropped any,
      // say so rather than show a green "Saved" over a credential that is not
      // there - it means this site's Square module needs updating.
      if (Array.isArray(d.skipped) && d.skipped.length > 0) {
        throw new Error(
          `Not stored: ${d.skipped.join(', ')}. Update the Square module to its latest version, then save again.`
        )
      }
      setSavedConn(true)
      setValues({})
      await load()
    } catch (err) {
      setConnError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingConn(false)
    }
  }

  async function patchSettings(patch: Partial<Settings>): Promise<Settings | null> {
    const res = await fetch('/api/m/square-payment-for-shop/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const d = await res.json()
    if (!res.ok) throw new Error(d.error ?? 'Failed to save')
    setSettings(d as Settings)
    return d as Settings
  }

  async function saveSettings(next: Settings) {
    setSavingSettings(true)
    setSavedSettings(false)
    setSettingsError('')
    try {
      const saved = await patchSettings(next)
      // Whether Square is "connected" is a different question in the two modes -
      // on-page needs the Application ID as well - so the panel above has to be
      // asked again rather than left showing the answer to the old one.
      if (saved && saved.cardEntry !== settings?.cardEntry) await load()
      setSavedSettings(true)
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingSettings(false)
    }
  }

  // Which environment is live is a stored setting, not an environment variable,
  // so it applies at once - no deployment, and nothing to press Save for. The
  // status panel is re-read straight afterwards because the answer to "is this
  // connected" is entirely different for the other environment's credentials.
  async function chooseEnvironment(next: Environment) {
    const previous = environment
    setEnvironment(next)
    setSavingConn(true)
    setSavedConn(false)
    setConnError('')
    try {
      await patchSettings({ environment: next })
      await load()
    } catch (err) {
      setEnvironment(previous)
      setConnError(err instanceof Error ? err.message : 'Could not switch environment')
    } finally {
      setSavingConn(false)
    }
  }

  // Which credentials the running server still cannot see, split by WHY.
  //
  // "Saved" and "working" are two different things here and the gap between
  // them is a deployment: a credential written through /api/admin/env goes to
  // the hosting project, and the running server carries on with the old
  // environment until the site next deploys. So a box can perfectly well show
  // "(set)" - that list comes from the hosting project - while the status
  // panel, which reads what the server can actually see, still says no.
  //
  // Saying "add the access token and location ID and Application ID" at that
  // moment is wrong twice over: two of them were added long ago, and the third
  // was added a minute before. What is wanted is a deployment.
  function missingCredentials(): { pending: string[]; absent: string[] } {
    const env = (status?.environment === 'production' ? 'production' : 'sandbox') as Environment
    const wanted: Array<{ field: FieldDef['field']; label: string; seen: boolean }> = [
      { field: 'accessToken', label: 'access token', seen: status?.accessTokenSet !== false },
      { field: 'locationId', label: 'location ID', seen: status?.locationIdSet !== false },
    ]
    // Only on-page card entry needs it; on the hosted page it is not missing,
    // it is simply not used.
    if (status?.cardEntry === 'on-page') {
      wanted.push({ field: 'applicationId', label: 'Application ID', seen: status?.applicationIdSet !== false })
    }
    const pending: string[] = []
    const absent: string[] = []
    for (const c of wanted) {
      if (c.seen) continue
      ;(setVars[envVarName(env, c.field)] ? pending : absent).push(c.label)
    }
    return { pending, absent }
  }

  function renderCredentials(env: Environment) {
    const meta = ENVIRONMENTS.find((e) => e.id === env)!
    const isLive = environment === env
    const found = locations[env]
    const onlyLocation = found.length === 1 ? found[0] : undefined

    return (
      <div
        key={env}
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-4)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
          <strong style={{ color: 'var(--color-text)' }}>{meta.label}</strong>
          {isLive && (
            <span
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--color-success, var(--color-text-secondary))',
                border: '1px solid currentColor',
                borderRadius: 'var(--radius-sm)',
                padding: '0 var(--space-2)',
              }}
            >
              In use
            </span>
          )}
        </div>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-3)' }}>
          {meta.hint}
        </p>

        {FIELDS.map(({ field, label, placeholder, secret, optional, help }) => {
          const key = envVarName(env, field)
          return (
            <div className="field" key={key}>
              <label htmlFor={`sqp-${key}`}>
                {label}
                {optional && (
                  <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                    (optional)
                  </span>
                )}
                {setVars[key] && (
                  <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-success, var(--color-text-secondary))' }}>
                    (set)
                  </span>
                )}
              </label>
              {help && (
                <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
                  {help}
                </p>
              )}
              <input
                id={`sqp-${key}`}
                type={secret ? 'password' : 'text'}
                value={values[key] ?? ''}
                placeholder={setVars[key] ? 'Leave blank to keep current value' : placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                autoComplete="off"
              />

              {field === 'locationId' && (
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={lookingUp === env}
                    onClick={() => lookUpLocations(env)}
                  >
                    {lookingUp === env ? 'Looking up…' : 'Look up locations'}
                  </button>
                  {lookupError[env] && (
                    <p style={{ color: 'var(--color-danger, var(--color-text))', fontSize: 'var(--text-sm)', margin: 'var(--space-2) 0 0' }}>
                      {lookupError[env]}
                    </p>
                  )}
                  {found.length > 1 && (
                    <select
                      style={{ marginTop: 'var(--space-2)' }}
                      value={values[key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    >
                      <option value="">Choose a location…</option>
                      {found.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                          {l.currency ? ` (${l.currency})` : ''}
                          {l.status !== 'ACTIVE' ? ' - inactive' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  {onlyLocation && (
                    <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: 'var(--space-2) 0 0' }}>
                      Found <strong>{onlyLocation.name}</strong> and filled it in above.
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="card">
        <h2 className="card-title">Square</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
          Take card payments through Square - on your own checkout or on Square&apos;s page,
          whichever you prefer. Card details never touch this site either way. Sandbox and
          production have their own credentials, so each gets its own box below; fill in whichever
          you are using, pick which one the shop should use, then turn the method on. Credentials
          come from the{' '}
          <a href="https://developer.squareup.com/apps" target="_blank" rel="noreferrer">
            Square developer dashboard
          </a>
          .
        </p>

        {connError && <div className="alert alert-danger">{connError}</div>}
        {savedConn && <div className="alert alert-success">Saved. Changes take effect after the next deployment.</div>}

        {status && (
          !status.configured ? (
            (() => {
              const { pending, absent } = missingCredentials()
              return (
                <>
                  {pending.length > 0 && (
                    <div className="alert alert-warning">
                      Saved, but not live yet. The {listWords(pending)} for{' '}
                      <strong>{status.environment}</strong>{' '}
                      {pending.length === 1 ? 'is' : 'are'} stored with your hosting and will start
                      working after the site&apos;s next deployment - credentials only reach the
                      running site when it redeploys. Deploy from the notification on your dashboard,
                      then come back to this page.
                    </div>
                  )}
                  {absent.length > 0 && (
                    <div className="alert alert-warning">
                      Not connected yet - add the {listWords(absent)} for{' '}
                      <strong>{status.environment}</strong> below.
                    </div>
                  )}
                  {pending.length === 0 && absent.length === 0 && (
                    <div className="alert alert-warning">
                      Not connected yet - check the credentials for <strong>{status.environment}</strong> below.
                    </div>
                  )}
                </>
              )
            })()
          ) : status.connected ? (
            <div className="alert alert-success">
              Connected to Square (<strong>{status.environment}</strong>).
            </div>
          ) : (
            <div className="alert alert-danger">
              Credentials are set but Square rejected them{status.error ? `: ${status.error}` : ''}.
            </div>
          )
        )}

        {status?.configured && !status.webhookConfigured && (
          <div className="alert alert-warning">
            No webhook signature key for <strong>{status.environment}</strong> yet. Payments still go
            through and are confirmed when the shopper comes back from Square - but a shopper who
            pays and then closes the tab will need confirming by hand. Add the webhook URL below in
            Square, then paste its signature key in.
          </div>
        )}

        {/* Outside the local-development branch on purpose: the choice is kept
            here rather than in the hosting project, so it works the same way
            everywhere and needs no deployment to take hold. */}
        <div className="field">
          <label htmlFor="sqp-environment">Which environment the shop uses</label>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
            Saved as soon as you pick it and live straight away - no deployment needed. Each
            environment uses its own credentials, so make sure the ones below are filled in for
            whichever you choose.
          </p>
          <select
            id="sqp-environment"
            value={environment}
            disabled={savingConn}
            onChange={(e) => chooseEnvironment(e.target.value === 'production' ? 'production' : 'sandbox')}
          >
            <option value="sandbox">Sandbox (testing)</option>
            <option value="production">Production</option>
          </select>
        </div>

        {localMode ? (
          <div className="alert alert-warning">
            Local development mode: set the credentials for the environment chosen above (
            <code>SQUARE_ACCESS_TOKEN</code>, <code>SQUARE_LOCATION_ID</code> and, for card entry on
            your own checkout, <code>SQUARE_APPLICATION_ID</code> - or their{' '}
            <code>SQUARE_SANDBOX_</code> twins) in <code>.env.local</code> and restart the dev
            server.
          </div>
        ) : (
          <>
            {ENVIRONMENTS.map((e) => renderCredentials(e.id))}

            <button className="btn btn-primary" disabled={savingConn} onClick={saveConnection}>
              {savingConn ? 'Saving…' : 'Save connection'}
            </button>
          </>
        )}

        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="sqp-webhook-url">Webhook URL</label>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
            Add this as a webhook subscription in your Square developer dashboard (subscribe to the
            payment events) so payments are confirmed automatically. Square shows the signature key
            for the subscription once it exists - paste that into the box above. The URL must match
            exactly - Square&apos;s signature covers it. Sandbox and production each need their own
            subscription.
          </p>
          <input id="sqp-webhook-url" type="text" value={webhookUrl} readOnly onFocus={(e) => e.target.select()} />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Payment method</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-4)' }}>
          When switched on, card payment through Square appears as a payment option at checkout (as
          long as the connection above is working).
        </p>

        {settingsError && <div className="alert alert-danger">{settingsError}</div>}
        {savedSettings && <div className="alert alert-success">Saved.</div>}

        {settings && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', margin: '0 0 var(--space-4)', color: 'var(--color-text)' }}>
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={savingSettings}
                onChange={(e) => saveSettings({ ...settings, enabled: e.target.checked })}
              />
              Offer Square card payments at checkout
            </label>

            <div className="field">
              <label htmlFor="sqp-card-entry">Where the card is typed</label>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
                Either way the card goes straight to Square in Square&apos;s own secure fields and
                never touches this site. The difference is whether the shopper leaves your checkout
                to do it - and a good few who leave never come back.
              </p>
              <select
                id="sqp-card-entry"
                value={settings.cardEntry}
                disabled={savingSettings}
                onChange={(e) => saveSettings({ ...settings, cardEntry: e.target.value === 'on-page' ? 'on-page' : 'hosted' })}
              >
                <option value="on-page">On your own checkout (recommended)</option>
                <option value="hosted">On Square&apos;s own page</option>
              </select>
              {settings.cardEntry === 'on-page' && status && !status.applicationIdSet && (
                <div className="alert alert-warning" style={{ marginTop: 'var(--space-2)' }}>
                  No Application ID for <strong>{status.environment}</strong> yet, and the card form
                  cannot be drawn without one - so this payment method will not be offered at
                  checkout until you add it above.
                </div>
              )}
            </div>

            {settings.cardEntry === 'on-page' && (
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--color-text)' }}>
                  <input
                    type="checkbox"
                    checked={settings.walletsEnabled}
                    disabled={savingSettings}
                    onChange={(e) => saveSettings({ ...settings, walletsEnabled: e.target.checked })}
                  />
                  Offer Apple Pay and Google Pay
                </label>
                <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: 'var(--space-2) 0 0' }}>
                  Adds the wallet buttons just above your Place order button, using the same Square
                  account as the card fields. Each shopper only sees the one their device actually
                  offers - Apple Pay on Apple devices, Google Pay nearly everywhere else - and
                  anyone whose device offers neither simply carries on paying by card.
                </p>
                {settings.walletsEnabled && (
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <label htmlFor="sqp-apple-domain">Apple Pay domain file</label>
                    <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
                      Google Pay works the moment you tick the box above. Apple is fussier: it wants
                      proof you own this website before it will show its button. Register your
                      domain in your Square dashboard under Apple Pay, download the small file
                      Square gives you, open it in any text editor and paste the contents here.
                      Until you do, the Apple Pay button stays hidden - a button that always fails
                      is worse than no button at all.
                    </p>
                    <textarea
                      id="sqp-apple-domain"
                      rows={4}
                      value={settings.applePayDomainAssociation}
                      placeholder="Paste the contents of the file Square gave you"
                      onChange={(e) => setSettings({ ...settings, applePayDomainAssociation: e.target.value })}
                      onBlur={() => saveSettings(settings)}
                      style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--text-sm)' }}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <label htmlFor="sqp-description">Payment description</label>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>
                What this payment method is called at your checkout and on your orders, and what
                the shopper sees on their Square receipt (with the order number added). Leave blank
                for &ldquo;Card payment (Square)&rdquo;.
              </p>
              <input
                id="sqp-description"
                type="text"
                maxLength={100}
                value={settings.paymentDescription}
                placeholder="e.g. Card payment"
                onChange={(e) => setSettings({ ...settings, paymentDescription: e.target.value })}
                onBlur={() => saveSettings(settings)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
