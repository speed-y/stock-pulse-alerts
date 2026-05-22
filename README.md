# Stock Pulse

Daily BUY / HOLD / SELL alerts for NSE ETFs, delivered to your inbox. Powered by Yahoo Finance prices, Gemini AI sentiment analysis (with Google Search grounding), and Gmail reply tracking.

## How it works

1. Runs daily at 4–5 PM IST via an Apps Script time trigger
2. Fetches 30-day price history from Yahoo Finance
3. Asks Gemini (with live Google Search) for a sentiment verdict
4. Maps sentiment → signal using fixed investment tiers
5. Emails you the signal, action, and P&L
6. Reads your `bought` / `sold` replies to track holdings over time

## Supported tickers

Pre-configured with tailored Gemini search hints. Any Yahoo Finance `.NS` / `.BO` symbol works too — unknown tickers get generic defaults.

| Symbol | ETF |
|--------|-----|
| `GOLDCASE.NS` | Gold ETF |
| `SILVERBEES.NS` | Silver ETF |
| `NIFTYBEES.NS` | Nifty 50 Index ETF |
| `JUNIORBEES.NS` | Nifty Next 50 ETF |
| `ICICIB22.NS` | Bharat Bond ETF 2032 |
| `LIQUIDBEES.NS` | Nippon Liquid ETF |

## Signal tiers

| Gemini sentiment | Signal | Action |
|-----------------|--------|--------|
| Strongly Bullish | BUY | Invest ₹40,000 |
| Bullish | BUY | Invest ₹20,000 |
| Neutral | HOLD | — |
| Bearish | SELL | Sell 40% of holdings |
| Strongly Bearish | SELL | Sell 75% of holdings |

---

## Setup

### 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Rename it to `Stock Pulse`
3. Note the script ID from the URL: `https://script.google.com/d/<SCRIPT_ID>/edit`

### 2. Set Script Properties

**Project Settings → Script Properties → Add property**

| Property | Value |
|----------|-------|
| `GEMINI_API_KEY` | Get from [aistudio.google.com](https://aistudio.google.com) |
| `GEMINI_MODEL` | `gemini-2.0-flash` *(or newer — must support Google Search grounding)* |
| `MY_EMAIL` | Your personal Gmail address |
| `SENDER_EMAIL` | Gmail address that sends the alerts — can be the same as `MY_EMAIL`, or a dedicated alias |
| `BCC_EMAILS` | Comma-separated CC addresses *(optional)* |
| `TICKERS` | Comma-separated Yahoo symbols, e.g. `GOLDCASE.NS,SILVERBEES.NS` |
| `INITIAL_HOLDINGS_GOLDCASE` | Units you already held before using this script *(optional)* |
| `INITIAL_AVG_PRICE_GOLDCASE` | Avg buy price of those units *(optional)* |

> Repeat `INITIAL_HOLDINGS_<NAME>` / `INITIAL_AVG_PRICE_<NAME>` for each ticker (e.g. `INITIAL_HOLDINGS_SILVERBEES`).

### 3. Add a time trigger

**Triggers (clock icon) → Add trigger**

| Setting | Value |
|---------|-------|
| Function | `runAlerts` |
| Event source | Time-driven |
| Type | Day timer |
| Time | 4 PM – 5 PM (IST) |

### 4. Authorise

Run `runAlerts` once manually (▶ Run). Grant the requested Gmail + network permissions.

---

## Reply format

Reply to any alert email to confirm a trade. The script reads your Sent mail to track holdings.

```
bought               → confirm recommended units at the alert price
bought 500 @ 24.50   → custom units at a custom price
sold                 → confirm the recommended sell quantity
sold 300             → custom sell quantity
```

---

## Development & deployment

This repo uses [clasp](https://github.com/google/clasp) to sync code with Apps Script.

### One-time local setup

```bash
npm install -g @google/clasp
clasp login                          # opens browser OAuth flow
```

Update `.clasp.json` with your script ID:

```json
{ "scriptId": "YOUR_SCRIPT_ID_HERE", "rootDir": "." }
```

### Manual deploy

```bash
clasp push --force
```

### Automatic deploy via GitHub Actions

Every push to `main` that touches `Code.gs` or `appsscript.json` triggers an automatic deploy. See [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**One-time secret setup:**

1. Enable the Apps Script API: [script.google.com/home/usersettings](https://script.google.com/home/usersettings)
2. Run `clasp login` locally (if you haven't already)
3. Copy your credentials:
   ```bash
   cat ~/.clasprc.json
   ```
4. In GitHub → **Settings → Secrets → Actions**, add:
   - `CLASPRC` → paste the full contents of `~/.clasprc.json`
   - `CLASP_SCRIPT_ID` → your Apps Script script ID

That's it — any merge to `main` will push the latest code to your Apps Script project automatically.

---

## Files

| File | Purpose |
|------|---------|
| `Code.gs` | All script logic |
| `appsscript.json` | Apps Script manifest (timezone, OAuth scopes) |
| `.clasp.json` | Clasp config — add your script ID here |
| `.claspignore` | Tells clasp to only deploy `.gs` and manifest files |
| `.github/workflows/deploy.yml` | Auto-deploy to Apps Script on push to `main` |
