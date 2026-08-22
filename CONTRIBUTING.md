# Contributing

Thanks for taking the time. Bug reports, fixes and features are all welcome.

## Getting set up

```bash
npm install                 # also fetches MediaPipe assets
cp .env.example .env.local  # fill in Supabase + LiveKit values
npm run dev
```

You need a Supabase project and a LiveKit server to run the app end to end.
For pure logic work, `npm test` needs neither.

## Before opening a pull request

```bash
npm test                            # unit tests
npm run lint
npm run build
bash scripts/check-china-safe.sh    # see below
```

## House rules

These are not style preferences — each one exists because breaking it caused a
real bug at some point.

**1. `livekit-client` and `@livekit/track-processors` stay inside
`lib/media/providers/livekit/`.** Everything else depends on the interface in
`lib/media/types.ts`. Enforced by ESLint and by `check-china-safe.sh`.

**2. Extend `lib/media/types.ts` by declaration merging, never by editing
earlier blocks.** Each extension is appended in a dated, commented block.

**3. No resources that are blocked in mainland China.** No Google Fonts, no
Google Analytics, no reCAPTCHA, no CDN-hosted model assets. `check-china-safe.sh`
greps for these; if it fails, self-host the asset instead of adding an
exception.

**4. The browser must not talk to Supabase directly.** All data access goes
through `/api/*`. `createBrowserClient` is banned by the same script.

**5. Every interactive element is either wired up or visibly disabled with a
reason.** No buttons that look clickable and silently do nothing. Prefer a
disabled control with a tooltip explaining why.

**6. Loading states must be real.** If an operation takes time (the first
background-effect activation downloads ~10 MB of model assets), `await` the
actual work. Never fake it with a timer.

**7. Put business logic in pure functions and test it.** Components should be
thin. Tests must not import `lib/supabase.server.ts`.

## Commit messages

Describe what changed and why, in enough detail that someone bisecting later
understands the intent. Explaining a non-obvious root cause in the commit body
is encouraged — several of the trickier fixes in this repo are documented that
way.

## Reporting security issues

Please do not open a public issue for a vulnerability. Report it privately via
GitHub's security advisory feature on this repository.
