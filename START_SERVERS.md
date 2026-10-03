# How to Start SuppliWise Servers

## Quick Start (Run these commands in separate terminals)

### Terminal 1 - Backend Server
```cmd
cd C:\Users\johnr\SuppliWise\server
node index.js
```

### Terminal 2 - Frontend Development Server
```cmd
cd C:\Users\johnr\SuppliWise\my-react-app
npm run dev
```

## The Problem

The error "Unexpected end of JSON input" happens when:
- The backend server (Node.js) is NOT running
- The frontend tries to make API calls to `/api/auth/register` or `/api/auth/login`
- But there's no server listening, so it gets an empty response
- Empty response = can't parse as JSON = error

## Solution

**You MUST have BOTH servers running:**

1. **Backend (port 5000)** - Handles database, authentication, AI recommendations
2. **Frontend (port 5173 or 3000)** - React app that users see

## How to Check if Backend is Running

Open browser and go to: `http://localhost:5000`

- If you see a message or "Cannot GET /", backend is running ✅
- If you see "can't reach this page" or connection refused, backend is NOT running ❌

## Current Status Check

Run this in PowerShell to see what's running:
```powershell
netstat -ano | findstr ":5000"
netstat -ano | findstr ":5173"
```

If you see results, the servers are running on those ports.

## Environment Variables

Make sure `server/.env` has:
```
PORT=5000
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_secret_key
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
```

## Troubleshooting

1. **Backend won't start**: Check MongoDB connection in `.env`
2. **Frontend can't connect**: Make sure backend is on port 5000
3. **CORS errors**: Check `index.js` has CORS enabled for `http://localhost:5173`
