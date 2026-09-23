# SuppliWise User Guide — Multiple Accounts & Saved Logins

This guide explains how signing in works in SuppliWise: using several accounts
at once, switching between them, the **“Save my login on this browser”**
checkbox, and what happens when you sign out.

No technical knowledge required — if you read only one page of this
documentation, read this one.

---

## 1. The basics in 30 seconds

- You can be signed in to **several different accounts at the same time** —
  one per browser tab. Tab 1 can be Account A while Tab 2 is Account B.
- Each account has **exactly one active session**. Signing in to the same
  account again — on any tab, in any browser, on any device — **immediately
  signs out its previous session**. Other accounts are never affected.
- Regular accounts **never time out**: you stay signed in until *you* sign
  out, or until a newer sign-in replaces your session. (The Admin Panel has
  its own separate inactivity timeout — it never applies to normal accounts.)
- On the Sign In form, the **“Save my login on this browser”** box (checked
  by default) lets you switch back to an account **without typing the
  password again**.

## 2. Signing in

1. Open **Sign In** (the `Sign In` button in the top bar) and enter your
   email and password.
2. Keep the box checked unless you are on a shared or public computer:

   > ☑ **Save my login on this browser**
   > *Switch accounts later without typing your password.*

   Unchecking it means this sign-in will not be saved, and switching back
   later will ask for your password.
3. Complete the verification step — by default we email you a one-time code;
   if you have enabled two-factor authentication, enter the code from your
   authenticator app instead.

**What “Save my login” stores:** a special *saved-login* marker for **that
one account** on this browser. It is **not** your password, and it is **not**
a copy of your session key — it can only be used to quietly re-open *that
account's own still-active session*. Signing out removes it (§6), and it can
never open any other account.

## 3. Your accounts live in Profile → Accounts

Click your **avatar** in the top bar (*Profile Settings*) and scroll to the
**Accounts** section:

> **Accounts**
> Accounts signed in on this browser. Switch instantly — every account keeps
> its own session, so the others stay signed in.

You will see:

- every account signed in on this browser — the one you are using is marked
  **Current** and shown first, then the most recently used;
- per row: a **Switch** button and a **Sign out** button;
- **+ Add another account** at the bottom.

The account list deliberately does **not** live in the navbar — the top bar
only links to your profile, and the Sign In / Sign Up pages never show a
signed-in account chip.

## 4. Adding and switching accounts

**Add another account**
Click **+ Add another account**. You arrive at the Sign In form with this
banner:

> Sign in to add another account. Your other accounts stay signed in on this
> browser.

(There is also a **Back to my session** link if you change your mind.) Sign
in normally — your other accounts keep running in their own tabs.

**Switch account**
Click **Switch** on the account you want (or click the row itself). One of
three things happens — fastest first:

1. **Silently, no password** — if you saved that account's login (§2), the
   app quietly re-opens it in this tab.
2. **Silently from another open tab** — if another tab is still using that
   account, this tab takes over its live session.
3. **Password form, prefilled** — otherwise you are taken to the Sign In form
   with that account's email filled in and a banner such as:

   > Sign in as jane@example.com to continue — your other accounts stay
   > signed in on this browser.

After a successful switch, the app opens your Dashboard on a **fresh page**
(the previous one is replaced), so nothing from the earlier account lingers
on screen or in your Back history.

## 5. One account, one session (why your other tab signed out)

This is by design, and it protects you:

- If you sign in to **Account A** again anywhere — new tab, another browser,
  your phone — **Account A's previous session ends immediately**. Any tab
  still holding it shows *“Your session has ended. Please sign in again.”*
  once and returns to the Sign In form.
- **Other accounts are untouched**: signing out, or re-signing Account A,
  never signs out Account B or C.
- Because the replaced session is gone, an old **saved login** for it stops
  working too — you will simply be asked for the password on the next switch,
  and a fresh successful sign-in (with the box checked) saves it again.

## 6. Signing out

Each account row in Profile → Accounts has a **Sign out** button:

1. The first click arms it — the button turns into **Confirm?**.
2. The second click signs that account out. (Clicking anywhere else cancels
   the pending confirmation.)

When you sign out an account:

- its session ends **everywhere it was running** — every open tab showing
  that account returns to the **Sign In** form right away;
- its **saved login is removed** from this browser;
- **all your other accounts stay signed in**, exactly as they were;
- you land on the **user Sign In form** — and pressing **Back** keeps you
  there. You are never bounced to the Admin Panel.

**Sign out** on the Profile page itself does the same thing for the account
you are currently using.

## 7. The Admin Panel is a separate thing

- Administrators see an **Admin Panel** button (instead of `Sign In`) when an
  admin session exists.
- Signing out of your *user* account never jumps into the admin panel, and
  an admin session never hijacks the user Sign In screen. The two flows stay
  completely separate.

## 8. Saved logins — control and safety

| You want to…              | Do this                                                  |
|---------------------------|----------------------------------------------------------|
| Never save logins        | Uncheck **Save my login** at sign-in                     |
| Remove one saved login   | Sign that account out (§6)                               |
| Remove everything        | Sign each account out, or clear this site's browser data |
| Use a shared computer    | Uncheck the box every time you sign in                   |

Safety properties you can rely on:

- A saved login **cannot** outlive its session: signing out, signing in
  again (§5), or an account ban kills it on the server immediately.
- Saving Account A's login never affects Account B — everything is per
  account.
- Your **password is never stored** in the browser, and a saved login never
  grants access to any account other than its own.

## 9. Tips

- **Multiple tabs = multiple accounts.** The easiest way to work with two
  accounts side by side is one tab each; each tab keeps its own account.
- **Closing a tab does not sign the account out** on the server. If the
  login was saved (or another tab is still open), you get back in without a
  password; otherwise the switch asks for it once.
- If you had the app open across an update, refresh once with
  **Ctrl+Shift+R** (Mac: **Cmd+Shift+R**) so you are running the latest
  version.

## 10. FAQ

**It asked for my password when switching — why?**
Either the box was unchecked at that account's last sign-in, that session
was replaced or signed out elsewhere (§5), or you are on a different
browser/device. Sign in once with the box checked and switching works
password-free again.

**Why did my other tab show “Your session has ended”?**
That account was signed in again (or signed out) somewhere else — one active
session per account is enforced (§5). Sign in again if you want it back.

**Do sessions expire while I'm away?**
No — regular sessions have no idle or absolute timeout. They end only by
signing out or being replaced (§5).

**Where did the chat bubble go?**
It intentionally does not appear on the Sign In, Sign Up, and Admin pages.

**Can two tabs run the same account with different data?**
No — one account means one active session; a second sign-in replaces the
first (§5). Different accounts in different tabs work fully independently.

**I cleared my browser data — what happened?**
Saved logins and the account list live in your browser, so they are gone;
sign in again (with the box checked) to restore password-free switching.
