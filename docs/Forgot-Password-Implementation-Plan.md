# 🔐 Forgot Password (OTP via Email) — Implementation Plan for TNPC

> **TL;DR:** Your repo already contains **~95% of this feature**. It was built in commit
> `bc9fc5a` ("added forgot password feature"), then the Login button was removed in
> `11ef336` ("removed forgot password") and replaced with "Contact TNPC office".
> The 3-step OTP flow (backend routes + `ForgotPassword.jsx` + route in `App.jsx`) is
> **still in the codebase and fully functional**. What's missing is only:
> 1. the **"Forgot Password?" link in `Login.jsx`** (restored in this branch ✅),
> 2. **email credentials in `.env`** (Gmail App Password — this is the "service" you must add),
> 3. a few **security hardening items** (rate limiting, OTP attempt caps).

---

## 1. What already exists in your code (audit)

| Piece | File | Status |
|---|---|---|
| 3-step reset UI (Email → OTP → New Password) | `frontend/src/pages/ForgotPasssword.jsx` | ✅ Complete |
| Route `/forgot-password` | `frontend/src/App.jsx` (line 44) | ✅ Registered |
| `POST /forgot-password` (generate + email OTP) | `backend/index.js` (line 149) | ✅ Complete |
| `POST /verify-otp` (validate OTP → issue reset JWT) | `backend/index.js` (line 227) | ✅ Complete |
| `PATCH /reset-password` (verify JWT → bcrypt hash → save) | `backend/index.js` (line 282) | ✅ Complete |
| OTP storage model with 5-min TTL auto-delete | `backend/models/otpSchema.js` | ✅ Complete |
| Email sending (Gmail SMTP + SendGrid fallback) | `backend/index.js` `sendEmail()` (line 1733) | ✅ Complete, needs credentials |
| "Forgot Password?" button on Login page | `frontend/src/pages/Login.jsx` | ❌ Was removed → **restored** |

The packages needed are **already in `backend/package.json`**: `nodemailer`, `@sendgrid/mail`, `bcrypt`, `jsonwebtoken`, `mongoose`. **No new npm packages are required** for the base flow.

---

## 2. The flow (how it works end-to-end)

```
┌──────────┐          ┌──────────────┐          ┌────────────┐          ┌───────────┐
│  Login   │          │  ForgotPass  │          │  Backend   │          │   MongoDB │
│  Page    │          │  word.jsx    │          │  (Express) │          │   + Gmail │
└────┬─────┘          └──────┬───────┘          └─────┬──────┘          └─────┬─────┘
     │ clicks "Forgot       │                        │                      │
     │ Password?" ──────────▶ /forgot-password        │                      │
     │                      │  Step 1: POST email ───▶ check user exists ───▶ Users
     │                      │                        │ gen 6-digit OTP ─────▶ OTP doc (TTL 5 min)
     │                      │                        │ send email via SMTP ─▶ user inbox
     │                      │ ◀── "OTP sent" ────────│                      │
     │                      │  Step 2: POST email+otp▶ match + expiry check ▶ OTP
     │                      │                        │ delete OTP (1-time) ─▶ OTP
     │                      │ ◀── resetToken (JWT,   │                      │
     │                      │      10 min expiry)    │                      │
     │                      │  Step 3: PATCH email +  │                      │
     │                      │  password + resetToken ▶ verify JWT ──────────▶ -
     │                      │                        │ bcrypt.hash(10) ─────▶ Users.password
     │                      │ ◀── "Password reset" ──│                      │
     │ ◀── redirect /login ──│                        │                      │
```

**Why a JWT `resetToken` between step 2 and 3?** So the "permission to change the
password" is stateless and short-lived (10 min). The user proves identity with the OTP
once, gets the reset token, and only the holder of that token can change the password.
`/reset-password` verifies the JWT **and** that it matches the requested email — so a
token issued for one account can't reset another.

---

## 3. Services to add / configure (the actual answer)

### 3.1 Email delivery service — pick ONE primary + ONE fallback

You already have code for two providers. You just need **credentials**:

#### Option A — Gmail SMTP (already coded, best for starting / college projects) ⭐ recommended to start
- **Free**, ~500 emails/day, zero code changes needed.
- **Requirement:** a Gmail account with **2-Step Verification enabled** → generate an
  **App Password** (16 chars). A normal Gmail password will NOT work — Google blocks it.
- Steps:
  1. Google Account → **Security** → turn on **2-Step Verification**.
  2. Search **"App Passwords"** (or go to `myaccount.google.com/apppasswords`).
  3. Create one named `TNPC SMTP` → copy the 16-character password.
  4. Put it in `backend/.env` (see §3.2).
- ⚠️ Downsides: shared IP reputation, daily caps, can break on cloud hosts occasionally
  (your code already has `connectionTimeout` + retry + SendGrid fallback for this reason).

#### Option B — Brevo (ex-Sendinblue) — *Enhanced with IPv4 support*
- **300 emails/day free**, no credit card required.
- **IPv4 Enhanced:** Full dual-tier integration supporting both Brevo HTTP REST API v3 (port 443 over HTTPS) and Brevo SMTP (`smtp-relay.brevo.com`), with `family: 4` IPv4 enforcement and `dns.setDefaultResultOrder("ipv4first")` to resolve network timeout issues.
- Setup: brevo.com → SMTP & API tab → copy API / SMTP key → set `BREVO_API_KEY` in `backend/.env`.

#### Option C — SendGrid (already coded as automatic fallback)
- 100 emails/day free. Set `SENDGRID_API_KEY` and the existing `sendEmail()` function
  will auto-fall back to it when Gmail fails. Verify your **sender identity** first.

#### Option D — Resend / Mailgun / Amazon SES (for scale, later)
- SES: cheapest at scale (~$0.10/1000 mails) but needs AWS setup + production access
  request. Only worth it if the portal sends thousands of mails (drive notifications).

> **Recommendation for TNPC:** Start with **Gmail App Password** (works with existing
> code today). When traffic grows, switch primary to **Brevo** (300/day free) and keep
> **SendGrid** as the fallback that's already wired.

### 3.2 Environment variables (`backend/.env`) — the only "configuration service"

```env
# --- required ---
MONGOURL=your_mongodb_atlas_connection_string
JWT_SECRET=a_long_random_string_min_32_chars      # used for BOTH login token & reset token
EMAIL=tnpc.college@gmail.com                      # sender Gmail
EMAIL_PASSWORD=abcd efgh ijkl mnop                # 16-char Gmail App Password (not login pw!)

# --- optional (fallbacks already coded) ---
SENDGRID_API_KEY=SG.xxxxx                         # auto-fallback if Gmail fails
FRONTEND_URL=https://your-frontend.vercel.app
PORT=5000
```

Never commit `.env` (already in your `.gitignore` ✅). On **Render**, add the same vars
in *Environment* tab; on **Vercel frontend**, only `VITE_BACKEND_URL` is needed.

### 3.3 No other external services needed
- OTP generation → `crypto`-style random in your own code (`Math.floor(100000 + Math.random()*900000)` — fine, but see §5 for a stronger option).
- OTP storage → your existing **MongoDB** (`otpSchema` with TTL index — Mongo auto-deletes docs after 300 s ✅).
- Password hashing → `bcrypt` ✅. Reset-token signing → `jsonwebtoken` ✅.

---

## 4. Frontend change made in this branch (`Login.jsx`)

Replaced the "Contact TNPC office" reminder with a real link to the existing flow:

```jsx
// handler
const handleForgotPassword = () => navigate('/forgot-password');

// link under the password field
<div className="flex justify-end items-center mt-1">
    <button type="button" onClick={handleForgotPassword}
        className="text-sm text-blue-600 hover:text-blue-700 hover:underline font-medium">
        Forgot Password?
    </button>
</div>
```

Also: after 2 failed login attempts, the yellow warning box now shows a
"Reset it using OTP →" button instead of the office-contact text.

`ForgotPasssword.jsx` itself needs **no changes** — it already calls:
- `POST /forgot-password` → `{ email }`
- `POST /verify-otp` → `{ email, otp }` → stores `resetToken`
- `PATCH /reset-password` → `{ email, password, resetToken }`
- 60 s resend cooldown timer, 6-box OTP input with auto-focus/backspace nav, 3-step progress bar — all done.

---

## 5. Security hardening (recommended before going live)

| # | Issue today | Fix |
|---|---|---|
| 1 | **No rate limiting** — anyone can spam `/forgot-password` and burn your email quota / bomb inboxes | `npm i express-rate-limit` → 3 requests / 10 min per IP on `/forgot-password`, 5 / 10 min on `/verify-otp` |
| 2 | **Unlimited OTP guesses** — a 6-digit OTP can be brute-forced | Add `attempts` field to `otpSchema`; on each failed verify `attempts++`; delete OTP when `attempts >= 5` |
| 3 | **Account enumeration** — `/forgot-password` returns 404 "No account found", telling attackers which emails exist | Return the same generic `200 {success:true, "If an account exists, an OTP was sent"}` whether or not the email exists (send mail only when it does) |
| 4 | **OTP stored in plain text** in Mongo | Store `bcrypt.hash(otp)` and compare with `bcrypt.compare` (optional — DB is private, but cheap to do) |
| 5 | **Resend cooldown only client-side** (60 s timer in React) | Enforce server-side: keep `lastSentAt` in the OTP doc (or check `createdAt`) and reject resends < 60 s apart |
| 6 | **Weak randomness** — `Math.random()` for OTP | Use `crypto.randomInt(100000, 1000000)` (Node built-in, cryptographically secure) |
| 7 | JWT_SECRET reuse | Fine to reuse, but make it ≥ 32 random chars; rotate if ever leaked |
| 8 | (Nice-to-have) After successful reset, **invalidate existing sessions** | Your tokens are stateless JWTs — either accept it, or store a `tokenVersion` on the user and bump it on reset so old JWTs fail |

**Rate limiter snippet (hardening #1):**

```js
const rateLimit = require("express-rate-limit");

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,   // 10 minutes
  max: 3,                     // 3 OTP requests per window
  message: { success: false, message: "Too many OTP requests. Try again later." }
});

app.post("/forgot-password", otpLimiter, async (req, res) => { /* ... */ });
```

**Attempt cap snippet (hardening #2)** — in `/verify-otp`, before the success path:

```js
if (!otpRecord) return res.status(400).json({ success: false, message: "Invalid OTP" });

otpRecord.attempts = (otpRecord.attempts || 0) + 1;
if (otpRecord.attempts >= 5) {
  await otpSchema.deleteOne({ _id: otpRecord._id });
  return res.status(400).json({ success: false, message: "Too many wrong attempts. Request a new OTP." });
}
await otpRecord.save();

if (otpRecord.otp !== otp.trim())   // wrong but attempts < 5
  return res.status(400).json({ success: false, message: "Invalid OTP" });
// ... expiry check + success path (delete record, sign resetToken)
```

---

## 6. Run-it-locally checklist

```bash
# backend
cd backend
npm install
# create .env with MONGOURL, JWT_SECRET, EMAIL, EMAIL_PASSWORD
npm run dev          # verify console shows: ✅ SMTP server is ready

# frontend
cd frontend
npm install
# .env -> VITE_BACKEND_URL=http://localhost:5000
npm run dev
```

Test path: `/login` → **Forgot Password?** → enter a registered email → check inbox for
the styled OTP mail → enter 6-digit code → set new password → log in with it.

**Quick API sanity check without the UI:**

```bash
curl -X POST http://localhost:5000/forgot-password -H "Content-Type: application/json" -d '{"email":"registered user"}'
curl -X POST http://localhost:5000/verify-otp       -H "Content-Type: application/json" -d '{"email":"registered user","otp":"123456"}'
curl -X PATCH http://localhost:5000/reset-password   -H "Content-Type: application/json" -d '{"email":"registered user","password":"newpass123","resetToken":"<from verify>"}'
```

---

## 7. Optional future upgrades

- **Toast on wrong OTP auto-focuses first box** (small UX polish in `ForgotPasssword.jsx`).
- **Dedicated mail service module** — move the transporter + `sendEmail()` into
  `backend/services/mailer.js` so routes stay slim and you can swap providers via env
  (`MAIL_PROVIDER=gmail|brevo|sendgrid`) instead of editing transporters in `index.js`.
- **OTP over SMS** for students without email — Twilio Verify / MSG91 (India-friendly, ~₹1/OTP).
- **Password-strength meter** on step 3 (frontend only, e.g. `zxcvbn`).

---

### Bottom line

> You don't need to *write* the forgot-password feature — it's already in your codebase.
> You need to **re-enable the entry point** (done in `Login.jsx` in this branch) and
> **add an email credential** (Gmail App Password in `.env`, or a Brevo/SendGrid key).
> Add the §5 hardening (rate limit + attempt cap) before exposing it publicly.

---

## 8. ✅ VERIFICATION REPORT (2026-08-25, executed end-to-end)

### Bugs found & fixed during this implementation

| # | Bug | Fix |
|---|---|---|
| 1 | `dotenv` loaded at line ~129, AFTER the mail transporter read `process.env.EMAIL` → transporter got `undefined` auth locally | Moved `require("dotenv").config()` to line 1 |
| 2 | Email lookup used raw regex `new RegExp("^" + email + "$", "i")` — breaks/injectable for emails with `+` (plus-addressing) or other regex chars | Added `escapeRegex()` helper; applied to all 9 lookup sites |
| 3 | Brevo SMTP key `xsmtpsib-…tu` **fails auth (535)** in every format — key is revoked/regenerated or Brevo SMTP not activated | Key commented out in `.env`; **Gmail App Password verified working and set as primary**. Paste a fresh Brevo key anytime to re-enable |
| 4 | No rate limiting / OTP attempt cap (brute-forceable) | `express-rate-limit` added: 5 OTP requests + 15 verify/reset attempts per IP / 10 min; OTP deleted after 5 wrong guesses; 60 s server-side resend cooldown; `crypto.randomInt` for OTPs |

### E2E test results (all against the live Atlas DB + real Gmail SMTP)

| Step | Result |
|---|---|
| 1. Login with old password | ✅ 200 + JWT |
| 2. POST /forgot-password | ✅ 200 — **OTP email delivered via Gmail** (check inbox of jnanendrarobbi@gmail.com, sent to the +tnpctest alias) |
| 3. Immediate resend | ✅ 429 "wait 60 seconds" |
| 4. Wrong OTP | ✅ 400 "Invalid OTP. 4 attempt(s) remaining." |
| 5. Correct OTP | ✅ 200 + 10-min resetToken JWT |
| 6. PATCH /reset-password | ✅ 200 |
| 7. OTP replay | ✅ 400 (single-use enforced) |
| 8. Old password after reset | ✅ 401 rejected |
| 9. Login with NEW password | ✅ 200 + JWT |
| Frontend `npm run build` | ✅ compiles |
| Vite proxy → backend | ✅ verified |

*(A throwaway test user `jnanendrarobbi+tnpctest@gmail.com` was used and deleted afterwards — your 3 real users were never touched.)*

### ⚠️ Before you deploy — do these

1. **Rotate every credential you pasted in chat** (Brevo key, Gmail App Password, Atlas password). Treat them as public now.
2. Update **Render** env vars with the new `backend/.env` values (esp. the new strong `JWT_SECRET` — old login tokens will be invalidated, users just log in again).
3. On **Vercel**, keep `VITE_BACKEND_URL=https://<your-render-app>.onrender.com`.
4. If you want Brevo as primary: Brevo → SMTP & API → *Create a new SMTP key* → uncomment `BREVO_API_KEY`/`BREVO_SMTP_LOGIN` in `.env` → restart. The code auto-prefers Brevo and falls back to Gmail.
