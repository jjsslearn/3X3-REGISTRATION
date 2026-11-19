# 3x3 Team Registration (Render + a simple Google Sheet)

No Google Cloud needed. Your Google Sheet gets a small built-in script (Apps Script), and the website talks to it.

* **Teams (public)**: open the site, click Register, choose the team, enter the secret key, fill in the players.
* **Organiser**: open `/#admin` and sign in with the username and password you set. Create categories (date-of-birth ranges), add teams (a secret key is generated for each), see registrations by category in registration order, download CSV.
* **Free jerseys**: the first 10 teams in each category (change with `FREE_JERSEYS`). Order is set by the server clock when the registration is saved.
* **Checks on the server**: wrong key refused, every player's date of birth must be inside the team's category, chest numbers and FIBA IDs must be unique, a FIBA ID can belong to only one team, a team registers only once.

## 1. Connect the Google Sheet (5 minutes)

1. Create a new, empty Google Sheet.
2. In the Sheet: **Extensions, Apps Script**. Delete the sample code and paste everything from `apps-script/Code.gs`.
3. At the top, change `PUT-A-LONG-RANDOM-TEXT-HERE` to your own long random text (for example 30 random letters and numbers). Keep a copy: it is your **SHEET_TOKEN**. Click Save.
4. **Deploy, New deployment**, gear icon, type **Web app**. Set *Execute as*: **Me**, *Who has access*: **Anyone**. Click Deploy.
5. Google asks for permission: Authorize access, choose your account, Advanced, "Go to ... (unsafe)", Allow. (It is your own script.)
6. Copy the **Web app URL** (it ends with `/exec`). This is your **SHEET_API_URL**.

The script creates three tabs by itself: `Categories`, `Teams` (holds the secret keys, so keep the Sheet private) and `Registrations` (one row per team, with Order and Free jersey columns).
Manage categories and teams on the Organiser page, not by typing in those two tabs. If you do edit them by hand, press **Reload from Google Sheet** on the Organiser page.
If you change `Code.gs` later, use Deploy, Manage deployments, edit, New version.

## 2. Put the website on Render

1. Put this folder in a GitHub repository.
2. On https://render.com: **New, Web Service**, pick the repository. Runtime **Node**, build command `npm install`, start command `node server.js` (`render.yaml` already holds these).
3. Add these **environment variables**:

| Name | Value |
|---|---|
| `SHEET_API_URL` | the Web app URL from step 1 |
| `SHEET_TOKEN` | the same long random text you put in `Code.gs` |
| `ADMIN_USER` | organiser username |
| `ADMIN_PASS` | organiser password (long and unique) |
| `SESSION_SECRET` | any long random text (keeps the organiser signed in across restarts) |
| `FREE_JERSEYS` | optional, default 10 |

4. Deploy. Open the Render address, go to `/#admin`, sign in, create categories, add teams, and send each team its secret key.

Notes: on Render's free plan the service sleeps when idle, so the first visit can take about a minute. Nothing is lost, because data lives in the Sheet. On registration day use a paid instance so it never sleeps.
Anyone with both the Web app URL and the token could change your data, so do not share them.

## Run on your computer

`npm install`, then `ADMIN_USER=admin ADMIN_PASS=test node server.js` and open http://localhost:3000.
Without `SHEET_API_URL` it uses memory only (data disappears when you stop it).
