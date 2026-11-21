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
npm test          # 25 tests
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
