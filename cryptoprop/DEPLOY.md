# CryptoProp – Deployment Guide

## Option 1: GoDaddy VPS (Recommended for full control)

1. Purchase a GoDaddy VPS (Linux, Ubuntu recommended)
2. SSH into your server
3. Install Node.js:
   ```
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
4. Upload your files (via SFTP or Git)
5. In the project folder, run:
   ```
   npm install
   npm start
   ```
6. To keep it running 24/7, use PM2:
   ```
   npm install -g pm2
   pm2 start server.js --name cryptoprop
   pm2 save
   pm2 startup
   ```
7. Point your GoDaddy domain to your VPS IP in DNS settings

---

## Option 2: Railway (Easiest – free tier available)

1. Go to https://railway.app and sign up
2. Click "New Project" → "Deploy from GitHub repo"
   - Or drag & drop this folder
3. Railway auto-detects Node.js and runs `npm start`
4. Add environment variables in the Railway dashboard:
   - `SESSION_SECRET` = any long random string
5. Your site goes live instantly with a railway.app URL
6. To use your own domain: Settings → Custom Domain

---

## Option 3: Render (Free tier available)

1. Go to https://render.com and sign up
2. New → Web Service → connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add `SESSION_SECRET` in Environment settings
6. Deploy — done!

---

## Environment Variables

| Variable         | Description                          | Required |
|------------------|--------------------------------------|----------|
| PORT             | Port to run on (auto-set by host)    | No       |
| SESSION_SECRET   | Secret key for user sessions         | Yes      |

---

## Notes
- `data.json` stores all application/user data. Back it up regularly.
- For production, consider switching to a real database (PostgreSQL, MongoDB).
- Make sure HTTPS is enabled on your host (Railway/Render do this automatically).
