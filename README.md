# Proglintor

Proglintor is a workplace insights suite for Proglint. It has three parts:

| Part | Where it runs | What it does |
|---|---|---|
| **Proglintor** (agent, this folder) | Every employee laptop (Windows, macOS, Ubuntu) | Starts automatically and tracks app usage and timing. It lists installed apps and runs the **weekend work check**. |
| **Proglintor Admin** (this folder) | IT / managers' computers | Signs in to the backend. You create **assets**, see each laptop's **live state and running apps**, review **weekend alerts** and set **policies**. |
| **Backend** ([Proglintor-Backend](https://github.com/dhinakaranproglint/Proglintor-Backend)) | A server (Django + PostgreSQL) | Stores everything and serves the agent and admin APIs. |

```
Employee laptops                    Server                              Admin computers
┌──────────────────────┐  HTTPS/HTTP  ┌───────────────────────────┐  sign-in  ┌──────────────────────┐
│ Proglintor agent │ ───────────▶ │ Django + DRF  (port 8000) │ ◀──────── │ Proglintor Admin │
│ starts at login,     │  heartbeat,  │ PostgreSQL                │  assets,  │ dashboard, assets,   │
│ tracks usage, queues │  usage,      │ /api/agent/*  /api/admin/*│  alerts,  │ alerts, policies     │
│ data when offline    │  alerts      └───────────────────────────┘  policy   └──────────────────────┘
└──────────────────────┘
```

## Setup in 5 steps
1. **Start the backend** (see the [Proglintor-Backend](https://github.com/dhinakaranproglint/Proglintor-Backend) README). For local development, run `./scripts/run-dev.sh`. On a server, run `docker compose up -d`.
2. **Create an admin login:** `python manage.py createsuperuser` in the backend folder.
3. **Open Proglintor Admin** and sign in with the backend address (e.g. `http://127.0.0.1:8000`) and that login.
4. Click **New asset**. Enter the asset ID, employee name, email, department and office. You get a **one-time enrollment code**.
5. On the employee's laptop, open **Proglintor** → **Connect** and enter the code. That's all: employees never type a server address. The asset turns **Online** within seconds.

> **Corporate security software:** tools like CrowdStrike Falcon or FortiClient on a laptop often block incoming connections. A backend running on someone's laptop then only works for that same laptop. The agent handles this case automatically by using 127.0.0.1. For the whole company, run the backend on a server.

## Install assistant (chat → approval → verified install)
Employees ask for software in plain language; an admin approves when needed; the laptop installs it and proves it did.
There are exactly two roles: **employee** (the enrolled laptop, in the Proglintor agent) and **admin** (a staff user, in Proglintor Admin).

```
Employee: "install slack"  ──►  Backend matches the approved catalogue, pins the installer, applies approval rules
                                         │ needs approval?  ──►  Admin ▸ Approvals: Approve / Decline (with a reason)
                                         ▼
Laptop agent claims the job ──► downloads (https, SHA-256 pinned) ──► installs ──► verifies ──► reports back
                                         ▼
Employee chat shows live progress; audit trail records who asked, who approved, what ran
```

**Employee (agent → *Install software*)**
- Chat in plain language: “Install Slack”, “I need vscode”, “what can I install?”, “status”, “cancel”, “try again”.
  *Request* creates a tracked request; *Check only* just tells you what would happen.
- Live activity card: waiting for approval → starting → real download bytes → installing → verifying → done. Failures say what happened in plain language
  and offer **Try again** (when retrying can help) or **Copy details for IT** (when it can't).
- Native notifications when a request is approved, declined, finished or fails.

**Admin (Proglintor Admin → *Approvals* and *Software catalogue*)**
- **Approvals:** pending requests with employee, device, installer details and pinned checksum; Approve / Decline (reason is shown to the employee);
  every request's full **audit trail**. A badge, desktop notification and tray entry announce new requests.
- **Software catalogue → Add software:** pick a **popular app** (Slack, Chrome, Firefox, Zoom, VS Code) or paste a **download link**. The admin app downloads it,
  works out the type, name, version, identifier, processor and size, reads **who signed it** and verifies the signature (`codesign`, Gatekeeper, expected Team ID for popular apps),
  and measures the SHA-256 that laptops will insist on. You only confirm the name, version and whether it needs approval. Unsigned or wrongly signed downloads are refused with a plain explanation.
  **What a link can be:** a direct installer link — macOS `.dmg`, `.zip` (containing exactly one `.app`) or `.pkg`; Windows `.msi` or `.exe` (silent options needed); Linux AppImage — **or the vendor's download page**.
  For a page, the admin app finds the installer links on it (including pages that fill in the version with JavaScript, such as sublimetext.com/download); one match is used automatically, several are offered to choose from, with your own platform recommended.
  **Pages that build their download links with a script** (Zoom's download page contains no installer links in its HTML): if a page yields nothing, the admin app opens it in a hidden, locked-down browser (sandboxed, in-memory session, https to public hosts only, 25 s deadline, never saves or runs anything),
  clicks its Download buttons like a person would and records the addresses it tries to open. They are offered with the buttons' own labels ("Download Zoom Workplace for Intel"), ranked by the app asked for and the laptop's system and processor, then checked like any other link.
  When a request matches a popular app and its page gives nothing, the verified popular-app download is used instead. Pasted links are tidied (a stray `$ `, quotes, `<brackets>`). A package whose metadata says a placeholder version like `1.0` takes the real version from the download address.
  Not supported, and explained when pasted: `.tar.xz`/`.tar.gz`/`.deb`/`.rpm`/`.7z` (refused instantly), Windows/portable `.zip`, App Store apps, and pages with no installer link.
  Saved links use the final, versioned address after redirects, so laptops later fetch the exact file you checked.
  To update an app, **Edit → Update to a newer version**: paste the new link; it must be signed by the same developer. Technical fields live under **Advanced details**; *Enter details yourself* is the fallback for anything the check can't read.
  **Windows `.exe` installers** are read directly (on any OS): product name and company from the installer's own version info, the digital-signature signer (an installer with no signature at all is refused, because laptops would refuse it), and the installer framework —
  Inno Setup, NSIS, WiX Burn or Squirrel — whose standard silent-install options are pre-filled (other frameworks still ask). The processor comes from the file name (`x64`, `arm64`) and the version from the installer or, failing that, the file name.
  Whether the Windows certificate is *valid* can only be proven on Windows, so the admin app shows the signer as information and laptops run the real Authenticode check before installing.
  Signature verification of **Mac** apps needs a Mac admin computer; on Windows/Linux the file is still measured and identified, with a note that it couldn't be verified there (laptops still verify before installing).

**Software that isn't in the catalogue yet.** If an employee asks for a real app that isn't approved (e.g. “install Rectangle”), the assistant (Gemini with web search) finds the vendor's official download page and says
whether it is free to use (free / open source / free tier with paid plans / paid / unknown), and the server pre-checks the link (public https only, no private-network or redirect tricks, reachable, looks like an installer or a page, host plausibly belongs to the vendor).
It then asks the employee “shall I ask IT to review it?”: **nothing reaches the admin until they say yes.** The admin sees a *New software* card with the suggested source, the licence assessment and the pre-checks, all labelled AI-suggested and unverified.
**Review & approve** downloads the file in the admin app and runs the same real checks as *Add software* (signature, Team ID, version, checksum, icon; pages with several downloads offer a choice, your platform first; a build for the wrong system or processor is blocked).
If the licence isn't clearly free the admin must tick *“I confirm our company is licensed to use this”*. Approving adds the app to the catalogue (pinned) and queues the install in one step; from then on it is available software and other employees just ask for it by name. The whole chain is in the audit trail.

**Safety rules (enforced, not just promised)**
- Employees can only install what is in the catalogue; the installer file must hash to the pinned SHA-256 or it is deleted unopened. Downloads must be `https`.
- On macOS the app is signature-checked (bundle id, `codesign`, optional Team ID, Gatekeeper) in a staging folder *before* it touches `/Applications`; an existing copy is swapped only after that, with rollback.
  A running app is never replaced, a newer version is never downgraded, unsafe zip paths/symlinks are refused.
- If the catalogue entry changes or is withdrawn after a request was made, that request is stopped instead of installing something nobody reviewed.
- Approvals are optimistic-locked (two admins can't both decide), expire after 7 days, and a disconnected laptop's open requests are closed so nothing follows the asset to its next laptop.
- Employees see no download links or checksums; employee tokens can't reach admin endpoints and vice-versa.

**Edge cases handled in the chat:** not connected / removed laptop, backend offline (retry re-uses the same request id, so nothing is duplicated),
double submissions and rapid-fire requests, ambiguous names (“visual studio” → pick one), typos (“Did you mean Slack?”), app not in the catalogue, already installed / newer version,
wrong OS or CPU, app open during install, no disk space, interrupted installs (agent restart is reported), results that couldn't be delivered (kept and retried),
prompt-injection / off-topic input, and a laptop re-assigned to someone else (the previous person's chat is cleared).

**Installer support:** macOS **zip** is tested end to end on a real Mac (real download, digest check, unpack, staging, the real `codesign`/Gatekeeper check, which correctly rejects an unsigned app).
macOS **dmg** and **pkg** (pkg asks the employee for administrator permission), Windows (msi/exe, Authenticode check) and Linux (AppImage) are implemented but not yet run against real signed vendor installers or on those platforms. Try each type with a real, signed installer before rolling out.
For local development only, `PROGLINTOR_ALLOW_LOOPBACK_HTTP=1` lets the agent download from `http://127.0.0.1`.

## Removing a laptop
Deleting an asset in the admin (or issuing a new enrollment code for it) deprovisions that laptop:
- Within about 30 seconds the agent shows **"This laptop was removed from Proglintor"**, with who it was assigned to and when, plus a native notification. Opening the app checks immediately.
- It stops sending anything to the server, discards answers that were still waiting to be sent, and forgets the old credentials and upload progress. Its own usage history stays on the laptop.
- To reconnect, the employee enters a new code on the **My Device** page. If the laptop is connected to a *different* asset, the previous person's history is **not** uploaded to it.
- The agent only treats a rejection as "removed" when the server says so explicitly (`device_removed`). Other errors, such as a proxy returning 401, never disconnect it.

## Setting the server address (IT, once)
The agent knows which server to use from `src/shared/server.json`, so employees only enter the enrollment code:
```json
{ "server": "https://pulse.proglint.com" }
```
Edit it **before building the installer** (`npm run dist:agent:…`). For testing you can instead set the `PROGLINTOR_SERVER` environment variable. The default is `http://127.0.0.1:8000` (this computer only). The address is never shown to employees, and error messages don't include it.

## Features
**Agent**
- Accurate per-app timing. On macOS and Windows, app switches are reported the moment they happen. No time is counted while the user is idle, locked or asleep.
- Dashboard with Day/Week/Month views, charts and timeline. Includes a tray/menu-bar popover.
- **Weekend work check:** when a development tool (VS Code, Xcode, JetBrains IDEs, terminals, Docker, Postman…) is used on a weekend day, a warning asks why. The answer is sent to the admin: reason, details, expected duration and approving manager. "Remind me later" is also reported, and the warning comes back after 2 hours. It asks at most once per day after an answer.
- Works offline. Usage and answers are kept on the laptop and sent when the server is reachable again.

**Admin** (signs in to the Django backend; nothing is stored locally)
- **Dashboard:** assets, online now, active time today, new alerts, live status of each employee, top apps, 7-day trend.
- **Assets:** create, edit, delete. Each asset shows live state (current app with a timer, running apps), today's apps, a 14-day chart, installed apps, device info and its alerts. You can issue a new enrollment code, which disconnects the old laptop.
- **Weekend alerts:** an inbox with New/Reviewed filters, private admin notes and desktop notifications.
- **Policies:** turn the check on or off, choose weekend days, and edit the message, the reasons and the dev-tool list. Agents pick up changes within a minute.
- **Settings:** backend connection and sign-out, the address to give employees, start at login, CSV export.

## Development
```bash
# 1) backend
cd ../Proglintor-Backend && ./scripts/run-dev.sh
# 2) desktop apps (another terminal)
cd Proglintor-Desktop
npm install
npm run admin     # admin console (sign in to http://127.0.0.1:8000)
npm run agent     # employee agent
npm test          # agent, admin, chat logic and installer tests
# end-to-end against the running backend:
PULSE_E2E_URL=http://127.0.0.1:8000 PULSE_E2E_USER=<admin> PULSE_E2E_PASS=<password> npm test
```
If you start these from VS Code's terminal and see `bad option` errors, run `unset ELECTRON_RUN_AS_NODE` first.

## Building installers
```bash
npm run dist:agent:mac    # dist/agent/Proglintor-*.dmg
npm run dist:admin:mac    # dist/admin/Proglintor Admin-*.dmg
npm run dist:agent:win    # on Windows → NSIS installer (per-machine)
npm run dist:agent:linux  # on Ubuntu → AppImage + .deb
```
`.github/workflows/build.yml` builds both apps for all three OSes on GitHub's runners.
Builds are unsigned. For company-wide rollout, sign with a *Developer ID Application* certificate (macOS) and a code-signing certificate (Windows).

## App icons
Icons for both apps (macOS `.icns`, Windows `.ico`, Linux `.png`) are in `assets/icons/` and are generated from the official Proglint logo:
```bash
pip install pillow && python3 scripts/make-brand-icons.py
```
The installer configs in `build/` already point at them.

## Security notes
- Each laptop gets its own random access token at enrollment. The backend stores only its SHA-256 hash.
- Enrollment codes are single use, and repeated wrong codes are blocked for 10 minutes.
- The admin app signs in with a Django staff account. Only `is_staff` users can use the admin API.
- Use HTTPS (a reverse proxy in front of the backend) when agents connect from outside the office network.
- Employees can see that the agent is running (tray icon), and the weekend window says the answer goes to the admin.

## Data locations
| | macOS | Windows | Linux |
|---|---|---|---|
| Agent | `~/Library/Application Support/Proglintor/` | `%APPDATA%\Proglintor\` | `~/.config/Proglintor/` |
| Admin (sign-in only) | `~/Library/Application Support/Proglintor Admin/backend.json` | `%APPDATA%\Proglintor Admin\` | `~/.config/Proglintor Admin/` |
| Backend | PostgreSQL (see backend `.env`) | | |

The agent also imports data from the earlier "Machine Monitor" edition on first run.
