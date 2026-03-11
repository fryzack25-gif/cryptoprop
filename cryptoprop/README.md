# CryptoProp Full Demo Site (Spot-only)

This folder contains:
- A crypto-native landing page (`index.html`)
- A login page (`login.html`)
- A mock trader dashboard (`dashboard.html`)
- A Node.js backend that:
  - Serves the frontend
  - Stores applications (JSON file)
  - Provides a demo login + auth token
  - Exposes a small API the dashboard uses

## Quick start (recommended)
1) Install Node.js (LTS)
2) Open a terminal in this folder and run:
   - `npm install`
   - `npm start`
3) Visit:
   - http://localhost:3000

## Demo login
- Email: `trader@cryptoprop.com`
- Password: `cryptoprop`

## What’s included
### Frontend pages
- `index.html` — landing + application form (POSTs to `/api/applications`)
- `login.html` — login form (POSTs to `/api/login`)
- `dashboard.html` — requires auth; shows mock metrics + loads applications list

### Backend API
- `POST /api/login` => returns `{ token, email }`
- `POST /api/applications` => saves an application (no auth required)
- `GET /api/applications` => lists applications (auth required)

## Notes
- This is a demo “login system” using a simple token. For production, use proper auth, hashing, rate limiting, and HTTPS.
- Replace evaluation tiers/rules/legal text before using publicly.


## Trading (spot) + live Coinbase prices
- Page: `paper.html` (labeled “Trading” in the UI)
- Fetches live tickers through the backend proxy:
  - `GET /api/market/ticker?product=BTC-USD`
- Paper account is stored in `localStorage` in your browser.


- Trading is now linked to server-side account liquidity (`/api/account`) and requires login.
- Place trades via `POST /api/trade` (simulated fills at last Coinbase price).

## Upgrades added
- Market orders: demo slippage + taker fee (server-side)
- Limit orders: maker fee, open-order table, cancel, and periodic processing
- Candlestick chart: Coinbase candles proxied via `/api/market/candles`

### New/updated endpoints
- `GET /api/market/candles?product=BTC-USD&granularity=3600&limit=100`
- `POST /api/orders/limit`
- `POST /api/orders/cancel`
- `POST /api/orders/process`

## Real-time prices (WebSocket) + faster polling
- The Trading page connects directly to Coinbase Exchange WebSocket feed for real-time ticker updates.
- A 1-second interval runs for limit-order processing and REST fallback refresh.

## Top 50 universe
- The UI loads a Top-50-by-market-cap universe and filters to Coinbase Exchange USD pairs via `/api/market/top50`.
- If CoinGecko is blocked or rate-limited, the app falls back to a small default allowlist.
- Optional: set `COINGECKO_API_KEY` (or `COINGECKO_API_BASE`) in your environment.

## Trading all Top 50
- Trading, ticker, and candles endpoints now accept any product in the dynamic Top-50 universe returned by `/api/market/top50`.
- If a coin is in CoinGecko top 50 but does not have a Coinbase Exchange USD pair, it will not appear in the universe.
